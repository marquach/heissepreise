const axios = require("axios");
const utils = require("./utils");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://online.eurospin.com";
const PAGE_SIZE = 100;

const HEADERS = {
    "x-ebsn-api-version": "2.1.0",
    "x-ebsn-client": "site",
    "x-ebsn-uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "x-ebsn-version": "1.4.4",
    accept: "application/json",
};

// Maps WEIGHT_UNIT_SELLING values (uppercase from API) to internal unit system.
// All lowercase keys because we call .toLowerCase() before lookup.
const units = {
    gr: { unit: "g", factor: 1 },
    kg: { unit: "g", factor: 1000 },
    ml: { unit: "ml", factor: 1 },
    lt: { unit: "ml", factor: 1000 },
    l: { unit: "ml", factor: 1000 },
    pz: { unit: "stk", factor: 1 },
    pcs: { unit: "stk", factor: 1 },
};

exports.getCanonical = function (item, today) {
    const price = item.price;
    if (price == null || price === 0) return null;

    const isWeighted = (item.priceUnitDisplay ?? "").toLowerCase() === "kg";

    let quantity = 1;
    let unit = "stk";

    const ws = item.productInfos?.WEIGHT_SELLING;
    const wu = item.productInfos?.WEIGHT_UNIT_SELLING?.toLowerCase();

    if (ws != null && wu && wu in units) {
        quantity = parseFloat(ws);
        unit = wu;
    } else if (isWeighted) {
        quantity = 1;
        unit = "kg";
    }

    return utils.convertUnit(
        {
            id: String(item.productId),
            name: item.name,
            description: item.description ?? "",
            price,
            priceHistory: [{ date: today, price }],
            unit,
            quantity,
            isWeighted,
            bio: /\bbio\b/i.test(item.name),
            url: item.itemUrl ?? `/${item.slug}`,
        },
        units,
        "eurospin"
    );
};

async function fetchCategoriesFromApi() {
    try {
        const resp = await axios.get(`${BASE_URL}/ebsn/api/category`, { headers: HEADERS });
        const data = resp.data?.data;
        const cats = [];

        function walk(node, parentId = null) {
            if (!node) return;
            if (node.categoryId) {
                cats.push({
                    id: node.categoryId,
                    parentId: parentId,
                    description: node.name ?? String(node.categoryId),
                    url: node.itemUrl ? `${BASE_URL}${node.itemUrl}` : null,
                    code: null,
                });
            }
            const children = node.children ?? node.categories ?? [];
            for (const child of children) walk(child, node.categoryId);
        }

        const root = Array.isArray(data) ? data : [data];
        for (const cat of root) walk(cat);
        return cats;
    } catch (e) {
        return [];
    }
}

async function fetchProductsForCategory(categoryId) {
    let page = 1;
    let totalPages = 1;
    const products = [];

    while (page <= totalPages) {
        const resp = await axios.get(`${BASE_URL}/ebsn/api/products`, {
            headers: HEADERS,
            params: { page, page_size: PAGE_SIZE, parent_category_id: categoryId },
        });
        const pageData = resp.data?.data;
        if (!pageData) break;

        products.push(...(pageData.products ?? []));
        totalPages = pageData.page?.totPages ?? 1;
        page++;
    }

    return products;
}

async function resolveCategoryIds() {
    // 1. Already initialized in memory
    if (exports.categoryLookup && Object.keys(exports.categoryLookup).length > 0) {
        return Object.keys(exports.categoryLookup).map(Number);
    }

    // 2. Stored JSON
    const mappingFile = path.join(__dirname, "eurospin-categories.json");
    if (fs.existsSync(mappingFile)) {
        const cats = JSON.parse(fs.readFileSync(mappingFile));
        if (cats.length > 0) return cats.map((c) => c.id).filter(Boolean);
    }

    // 3. Fetch from API
    const cats = await fetchCategoriesFromApi();
    if (cats.length > 0) return cats.map((c) => c.id);

    console.error("Eurospin: no category IDs available. Run initializeCategoryMapping first.");
    return [];
}

exports.fetchData = async function () {
    const categoryIds = await resolveCategoryIds();
    if (categoryIds.length === 0) return [];

    const seen = new Set();
    const allProducts = [];

    for (const catId of categoryIds) {
        const products = await fetchProductsForCategory(catId);
        for (const p of products) {
            if (!seen.has(p.productId)) {
                seen.add(p.productId);
                allProducts.push(p);
            }
        }
    }

    return allProducts;
};

exports.initializeCategoryMapping = async (rawItems) => {
    let categories;

    if (rawItems && rawItems.length > 0) {
        // Derive categories from product breadcrumbs
        const catMap = {};
        for (const item of rawItems) {
            if (!item.categoryId) continue;
            if (catMap[item.categoryId]) continue;
            const crumb = Array.isArray(item.breadCrumbs) ? item.breadCrumbs[item.breadCrumbs.length - 1] : null;
            catMap[item.categoryId] = {
                id: item.categoryId,
                description: crumb?.name ?? String(item.categoryId),
                code: null,
            };
        }
        categories = Object.values(catMap);
    } else {
        // Try API — returns full tree with parentId
        categories = await fetchCategoriesFromApi();
    }

    if (!categories || categories.length === 0) {
        const mappingFile = path.join(__dirname, "eurospin-categories.json");
        if (fs.existsSync(mappingFile)) {
            categories = JSON.parse(fs.readFileSync(mappingFile));
        } else {
            categories = [];
        }
    }

    categories = utils.mergeAndSaveCategories("eurospin", categories);

    // Build parent->code map: walk up hierarchy and assign codes from parents
    const codeByParent = {};
    const codeMap = {
        A: ["frutta", "verdura", "ortaggi"],
        B: ["carne", "pesce", "salumi"],
        C: ["latticini", "formaggi", "burro", "latte", "yogurt", "uova"],
        D: ["pane", "pasticceria", "pizza", "focaccia"],
        E: ["bevande", "acqua", "vino", "birra", "succhi", "caffè", "tè"],
        F: ["surgelati", "gelati", "surgelato"],
        G: ["dispensa", "riso", "pasta", "olio", "aceto", "spezie"],
        H: ["gastronomia", "pronto", "piatti"],
        I: ["dolci", "biscotti", "merendine", "cioccolato", "caramelle"],
        J: ["igiene", "cura", "bellezza", "sapone", "shampoo"],
        K: ["pulizia", "detergenti", "carta", "panni"],
    };

    const usedCodes = {};
    for (const cat of categories) {
        const desc = cat.description.toLowerCase();
        let code = null;

        for (const [letter, keywords] of Object.entries(codeMap)) {
            if (keywords.some((kw) => desc.includes(kw))) {
                if (!usedCodes[letter]) usedCodes[letter] = 0;
                code = letter + ++usedCodes[letter];
                codeByParent[cat.id] = code;
                break;
            }
        }
    }

    // Assign codes: main categories get their matched code, subcategories inherit from parent
    for (const cat of categories) {
        if (codeByParent[cat.id]) {
            cat.code = codeByParent[cat.id];
        } else if (cat.parentId && codeByParent[cat.parentId]) {
            cat.code = codeByParent[cat.parentId];
        }
        // else code stays null (unmapped)
    }

    exports.categoryLookup = {};
    exports.parentMap = {};
    for (const category of categories) {
        exports.categoryLookup[category.id] = category;
        if (category.parentId) {
            exports.parentMap[category.id] = category.parentId;
        }
    }
};

exports.mapCategory = (rawItem) => {
    const catId = rawItem.categoryId;
    if (!catId) return null;
    const categoryLookup = exports.categoryLookup;
    const parentMap = exports.parentMap;
    if (!categoryLookup) throw new Error("Category mapping for eurospin not initialized.");

    // Try direct lookup first
    let cat = categoryLookup[catId];
    if (cat?.code) return cat.code;

    // Walk up the hierarchy
    let currentId = catId;
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        cat = categoryLookup[currentId];
        if (cat?.code) return cat.code;
        currentId = parentMap?.[currentId];
    }

    return null;
};

exports.urlBase = "https://online.eurospin.com";
