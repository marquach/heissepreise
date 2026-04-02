const axios = require("axios");
const utils = require("./utils");

const MPREIS_PROXY_URL =
    "https://algolia-webhook.mpreis.at/algolia-proxy/1/indexes/main/query?X-Algolia-Application-Id=UZXORS8TL2&X-Algolia-Agent=Vue.js";
const MPREIS_SITE_ID = "8124";
const MPREIS_HITS_PER_PAGE = 1000;

const units = {
    grm: { unit: "g", factor: 1 },
    kgm: { unit: "g", factor: 1000 },
    ltr: { unit: "ml", factor: 1000 },
    mlt: { unit: "ml", factor: 1 },
    mtr: { unit: "m", factor: 1 },
    anw: { unit: "stk", factor: 1 },
    "bl.": { unit: "stk", factor: 1 },
    pkg: { unit: "stk", factor: 1 },
    gr: { unit: "g", factor: 1 },
    er: { unit: "stk", factor: 1 },
};

function getPrimaryCategory(rawItem) {
    if (Array.isArray(rawItem.category)) return rawItem.category[0] ?? null;
    return rawItem.category ?? null;
}

function getQuantityAndUnit(rawItem, isWeighted) {
    const isKnownUnit = (u) => u != null && (u in units || u in utils.globalUnits);

    const packagingUnit = rawItem.mixins?.productCustomAttributes?.packagingUnit;
    let [quantity, unit] = utils.parseUnitAndQuantityAtEnd(packagingUnit);

    if (quantity == null || unit == null || !isKnownUnit(unit)) {
        const fallbackUnit = isWeighted ? rawItem.prices?.base?.unit : rawItem.prices?.unit;
        quantity = fallbackUnit?.quantity ?? 1;
        unit = fallbackUnit?.code?.toLowerCase();
    }

    if (!isKnownUnit(unit) && rawItem.prices?.base?.unit) {
        quantity = rawItem.prices.base.unit.quantity ?? quantity;
        unit = rawItem.prices.base.unit.code?.toLowerCase() ?? unit;
    }

    if (!isKnownUnit(unit)) {
        unit = "stk";
        quantity = quantity ?? 1;
    }

    return { quantity, unit };
}

function getEffectivePrice(rawItem) {
    return (
        rawItem.app?.price ??
        rawItem.sitePrice?.effective ??
        rawItem.sitePrice?.original ??
        rawItem.sitePrices?.[MPREIS_SITE_ID]?.effective ??
        rawItem.sitePrices?.[MPREIS_SITE_ID]?.original ??
        null
    );
}

exports.getCanonical = function (item, today) {
    const isWeighted = (item.mixins?.productCustomAttributes?.packagingDescription ?? "").startsWith("Gewichtsware");
    const { quantity, unit } = getQuantityAndUnit(item, isWeighted);
    const price = getEffectivePrice(item);

    if (price == null) return null;

    return utils.convertUnit(
        {
            id: item.code,
            name: item.name,
            description: item.mixins?.productCustomAttributes?.longDescription ?? "",
            isWeighted,
            price,
            priceHistory: [{ date: today, price }],
            unit,
            quantity,
            bio: item.mixins?.mpreisAttributes?.properties?.includes("BIO"),
        },
        units,
        "mpreis"
    );
};

exports.fetchData = async function () {
    let mpreisItems = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
        const res = (
            await axios.post(MPREIS_PROXY_URL, {
                query: "",
                filters: "published",
                hitsPerPage: MPREIS_HITS_PER_PAGE,
                page,
            })
        ).data;
        mpreisItems = mpreisItems.concat(res.hits);
        totalPages = res.nbPages;
        page++;
    }

    return mpreisItems
        .filter((item) => getEffectivePrice(item) != null)
        .map((item) => ({
            code: item.code,
            name: item.name,
            available: item.available,
            categories: item.categories,
            category: item.category,
            category_ids: item.category_ids,
            mixins: item.mixins,
            prices: item.prices,
            sitePrice: item.sitePrices?.[MPREIS_SITE_ID],
            app: item.app,
        }));
};

function categoriesToPath(rawItem) {
    if (!rawItem.categories?.length) return null;

    const primaryCategory = getPrimaryCategory(rawItem);
    if (!primaryCategory) return null;

    const traversePath = (category, result) => {
        if (category.name == "ProductRoot") return;
        if (category.parent) traversePath(category.parent, result);
        result.push({ name: category.name, id: category.id });
    };
    const pathElements = [];
    traversePath(primaryCategory, pathElements);
    if (pathElements.length == 0) return null;

    const lastIndex = Math.min(3, pathElements.length) - 1;
    const result =
        pathElements
            .slice(0, lastIndex + 1)
            .map((el) => el.name)
            .join(" -> ") +
        "-" +
        pathElements[lastIndex].id;
    return result;
}

exports.initializeCategoryMapping = async (rawItems) => {
    rawItems = rawItems ?? (await exports.fetchData());

    const categoryLookup = {};
    for (const rawItem of rawItems) {
        const path = categoriesToPath(rawItem);
        if (!path) continue;

        categoryLookup[path] = {
            id: path,
            code: null,
            url: "https://www.mpreis.at/shop/c/" + path.match(/(\d+)$/)[1],
        };
    }
    let categories = [];
    Object.keys(categoryLookup).forEach((key) => categories.push(categoryLookup[key]));
    categories.sort((a, b) => b.id.localeCompare(a.id));
    categories = utils.mergeAndSaveCategories("mpreis", categories);
    exports.categoryLookup = {};
    for (const category of categories) {
        exports.categoryLookup[category.id] = category;
    }
};

exports.mapCategory = (rawItem) => {
    const path = categoriesToPath(rawItem);
    return exports.categoryLookup[path]?.code;
};

exports.urlBase = "https://www.mpreis.at/shop/p/";
