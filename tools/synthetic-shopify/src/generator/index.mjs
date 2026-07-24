// @ts-check
import crypto from "node:crypto";
import { money, quantile, shippingForMerchandise } from "./money.mjs";
import { SeededRandom } from "./random.mjs";
import { DEFAULT_API_VERSION, DEFAULT_SCENARIO, SYNTHETIC_TAG, resolveProfile } from "../config/profiles.mjs";

const BRAND = "Elsewhere Wine Co.";
const CURRENCY = "GBP";

const REGIONS = [
  {
    area: "Greater London",
    weight: 42,
    postcodes: ["E5", "N16", "SE15", "E17", "SW9", "NW6", "Walthamstow E17"],
  },
  {
    area: "South East England",
    weight: 12,
    postcodes: ["Brighton BN1", "Lewes BN7", "Canterbury CT1"],
  },
  {
    area: "South West England",
    weight: 8,
    postcodes: ["Bristol BS6", "Bath BA1", "Totnes TQ9"],
  },
  {
    area: "North West England",
    weight: 8,
    postcodes: ["Manchester M20", "Liverpool L17", "Chorlton M21"],
  },
  {
    area: "West Midlands",
    weight: 7,
    postcodes: ["Birmingham B13", "Leamington Spa CV32"],
  },
  {
    area: "East of England",
    weight: 6,
    postcodes: ["Norwich NR2", "Cambridge CB4"],
  },
  { area: "Yorkshire", weight: 5, postcodes: ["Leeds LS6", "York YO30"] },
  { area: "Scotland", weight: 4, postcodes: ["Glasgow G12", "Edinburgh EH6"] },
  { area: "Wales", weight: 3, postcodes: ["Cardiff CF24", "Swansea SA1"] },
  { area: "Northern Ireland", weight: 2, postcodes: ["Belfast BT9"] },
  {
    area: "Elsewhere UK",
    weight: 3,
    postcodes: ["Newcastle NE2", "Nottingham NG7", "Oxford OX4"],
  },
];

const FIRST_NAMES = ["Ada", "Maya", "Rory", "Sam", "Leah", "Nina", "Iris", "Theo", "Jude", "Imani", "Eli", "Mina", "Arlo", "Zara", "Kit", "Noah", "Tess", "Milo", "Asha", "Finn"];
const LAST_NAMES = ["Hale", "Verma", "Okafor", "Field", "Patel", "Morgan", "Stone", "Ibrahim", "Reid", "Khan", "Brooks", "Nolan", "Shah", "Morris", "Avery", "Bennett", "Cole", "Davies", "Frost", "Lennox"];

const PRODUCT_BLUEPRINTS = [
  ["white", "Moldova", "Codru", "Valea Lunca", "Salt Road Feteasca", "Feteasca Alba", 2024, 18],
  ["white", "Georgia", "Imereti", "Didi Mta", "Cloud Needle Tsolikouri", "Tsolikouri", 2024, 23],
  ["white", "Slovenia", "Vipava", "Kamen Drift", "Bora Line Rebula", "Rebula", 2023, 25],
  ["white", "Greece", "Crete", "Nisi Field", "Lemon Grove Vidiano", "Vidiano", 2024, 21],
  ["white", "Azores", "Pico", "Pedra Nuvem", "Basalt Tide Arinto", "Arinto dos Acores", 2023, 32],
  ["white", "Romania", "Transylvania", "Casa Vatra", "Meadow Clock", "Feteasca Regala", 2024, 17],
  ["red", "Uruguay", "Canelones", "Bodega Bruma", "Rain Map Tannat", "Tannat", 2023, 24],
  ["red", "Lebanon", "Bekaa", "Jabal Nahr", "Cedar Ink", "Cinsault and Syrah", 2022, 29],
  ["red", "Armenia", "Vayots Dzor", "Areni Yard", "Stone Apron Areni", "Areni Noir", 2023, 27],
  ["red", "Serbia", "Fruska Gora", "Mala Ravna", "Black Cherry Kadarka", "Kadarka", 2024, 20],
  ["red", "Croatia", "Dalmatia", "Konoba Mira", "Harbour Plavac", "Plavac Mali", 2022, 26],
  ["red", "Canary Islands", "Tenerife", "Ladera Clara", "Ash Path Listan", "Listan Negro", 2023, 31],
  ["orange", "Georgia", "Kakheti", "Qvevri Lane", "Apricot Compass", "Rkatsiteli", 2023, 26],
  ["orange", "Moldova", "Stefan Voda", "Panza Veche", "Amber Market", "Viorica", 2024, 22],
  ["orange", "Armenia", "Armavir", "Karmir Plot", "Quince Window", "Voskehat", 2023, 28],
  ["orange", "Romania", "Dobrogea", "Delta House", "Reed Bed Orange", "Tamaioasa", 2024, 19],
  ["orange", "Slovenia", "Styria", "Haloze Fold", "Pear Skin Sipon", "Sipon", 2022, 34],
  ["chilled_red", "Uruguay", "Maldonado", "Costa Brava", "Sea Mist Marselan", "Marselan", 2024, 22],
  ["chilled_red", "Greece", "Macedonia", "Kipos North", "Picnic Xinomavro", "Xinomavro", 2024, 20],
  ["chilled_red", "Croatia", "Istria", "Uvala Field", "Red Current Teran", "Teran", 2023, 24],
  ["bundle", "Mixed", "Discovery", "Elsewhere Cellar", "Borderlands Discovery Four", "Mixed bottles", 2026, 74],
  ["bundle", "Mixed", "Summer", "Elsewhere Cellar", "Cold Bench Six", "White, orange and chilled red", 2026, 89],
  ["bundle", "Moldova", "Regional", "Elsewhere Cellar", "Moldova Underlined", "Mixed Moldovan bottles", 2026, 64],
  ["bundle", "Mixed", "Gift", "Elsewhere Cellar", "Small Regions Gift Case", "Six bottle gift case", 2026, 95],
  ["white", "Serbia", "Sumadija", "Bela Soba", "Lime Tile Tamjanika", "Tamjanika", 2023, 16],
  ["red", "Moldova", "Valul lui Traian", "Noapte Yard", "Plum Ferry Rara", "Rara Neagra", 2022, 18],
  ["orange", "Lebanon", "Batroun", "Marj Light", "Pollen Jar Merwah", "Merwah", 2022, 36],
  ["white", "Canary Islands", "La Palma", "Nube Oeste", "Volcanic Table", "Albillo Criollo", 2022, 30],
  ["red", "Georgia", "Kartli", "Mtkvari Bend", "Old Road Saperavi", "Saperavi", 2021, 33],
];

const LAUNCH_PRODUCT_INDEX = 17;
const DECLINING_HERO_INDEX = 6;
const NO_RECENT_SALES_INDEX = 24;

/**
 * @param {{ profile?: string; seed?: number | string; asOf?: string; scenario?: string; config?: Record<string, unknown>; shopDomain?: string }} input
 */
export function generateSyntheticShopifyDataset(input = {}) {
  const profileName = input.profile || String(input.config?.profile || "realistic");
  const profile = resolveProfile(profileName, input.config?.counts && typeof input.config.counts === "object" ? input.config.counts : {});
  const scenario = input.scenario || String(input.config?.scenario || DEFAULT_SCENARIO);
  const asOf = new Date(input.asOf || "2026-07-23T12:00:00+01:00");
  if (Number.isNaN(asOf.getTime())) throw new Error(`Invalid --as-of timestamp: ${input.asOf}`);
  const randomSeed = Number(input.seed ?? 1042026);
  const rng = new SeededRandom(`${randomSeed}:${profile.name}:${scenario}:${asOf.toISOString()}`);
  const runId = createRunId({
    randomSeed,
    profile: profile.name,
    scenario,
    asOf: asOf.toISOString(),
    shopDomain: input.shopDomain || "unbound",
  });

  const products = buildProducts(profile, rng, scenario);
  const variants = products.flatMap((product) => product.variants);
  const collections = buildCollections(products);
  const customers = buildCustomers(profile, rng);
  const orders = buildOrders(profile, rng, asOf, products, customers, scenario);
  const refunds = buildRefunds(profile, rng, asOf, orders);
  const inventoryLocations = [
    {
      sourceId: "loc_london_warehouse",
      name: "London Warehouse",
      tags: syntheticTags(runId, profile.name, scenario),
    },
    {
      sourceId: "loc_events_sampling",
      name: "Events & Sampling",
      tags: syntheticTags(runId, profile.name, scenario),
    },
  ];
  const inventoryLevels = buildInventory(profile, rng, variants, inventoryLocations, scenario, asOf);

  return {
    meta: {
      brand: BRAND,
      runId,
      randomSeed,
      profile: profile.name,
      scenario,
      asOf: asOf.toISOString(),
      apiVersion: DEFAULT_API_VERSION,
      shopDomain: input.shopDomain || null,
      currency: CURRENCY,
      bundleInventoryModel: "independently_stocked_synthetic_skus",
      syntheticTags: syntheticTags(runId, profile.name, scenario),
    },
    plannedCounts: plannedCounts(profile, products, variants, customers, orders, refunds, inventoryLevels),
    collections,
    products,
    customers,
    orders,
    refunds,
    inventoryLocations,
    inventoryLevels,
    capabilityReport: "apps/shopify/scripts/synthetic-shopify/capability-report.md",
    metrics: summarizeDataset({
      products,
      variants,
      customers,
      orders,
      refunds,
      inventoryLevels,
    }),
  };
}

function buildProducts(profile, rng, scenario) {
  const totalProducts = profile.activeProducts + profile.archivedProducts + profile.draftProducts;
  const blueprints = expandedBlueprints(totalProducts, rng);
  const products = blueprints.map((blueprint, index) => {
    const [category, country, region, producer, title, grape, vintage, price] = blueprint;
    const status = index < profile.activeProducts ? "ACTIVE" : index < profile.activeProducts + profile.archivedProducts ? "ARCHIVED" : "DRAFT";
    const sourceId = `prod_${String(index + 1).padStart(3, "0")}`;
    const isBundle = category === "bundle";
    const variantCount = status === "ACTIVE" && !isBundle && [0, 3, 7, 12, 17].includes(index) ? 2 : 1;
    const variants = Array.from({ length: variantCount }, (_, variantIndex) => {
      const caseVariant = variantIndex === 1;
      const variantPrice = caseVariant ? money(Number(price) * 6 * rng.float(0.88, 0.93)) : Number(price);
      const sku = skuFor({
        category: String(category),
        country: String(country),
        vintage: Number(vintage),
        index,
        isBundle,
        caseVariant,
      });
      return {
        sourceId: `var_${String(index + 1).padStart(3, "0")}_${variantIndex + 1}`,
        productSourceId: sourceId,
        title: caseVariant ? "Case of six" : isBundle ? "Bundle" : "Single bottle",
        optionName: caseVariant ? "Format" : "Format",
        optionValue: caseVariant ? "Case of six" : isBundle ? "Bundle" : "Single bottle",
        sku,
        barcode: `95000${String(index + 1).padStart(4, "0")}${variantIndex}`,
        price: variantPrice,
        compareAtPrice: isBundle || (index === LAUNCH_PRODUCT_INDEX && rng.chance(0.5)) ? money(variantPrice * rng.float(1.08, 1.15)) : null,
        currency: CURRENCY,
        taxable: true,
        requiresShipping: true,
        inventoryTracked: true,
        inventoryPolicy: index === 8 ? "CONTINUE" : "DENY",
        weightGrams: caseVariant ? 7800 : isBundle ? 5200 : 1300,
      };
    });

    return {
      sourceId,
      title: String(title),
      handle: slugify(String(title)),
      status,
      vendor: String(producer),
      productType: productType(String(category)),
      category,
      country,
      region,
      producer,
      vintage,
      grape,
      tags: [...syntheticTags("source", profile.name, scenario), String(category), String(country), `scenario:${scenario}`],
      descriptionHtml: productDescription({
        category: String(category),
        country: String(country),
        region: String(region),
        producer: String(producer),
        title: String(title),
        grape: String(grape),
        vintage: Number(vintage),
        rng,
      }),
      sourceCreatedAt: daysAgoIso(rng.int(45, profile.historyDays - 20), new Date("2026-07-23T12:00:00Z")),
      variants,
      demandRole: index < 3 ? "hero" : index === DECLINING_HERO_INDEX ? "former_hero" : index === LAUNCH_PRODUCT_INDEX ? "recent_launch" : index === NO_RECENT_SALES_INDEX ? "dormant" : isBundle ? "bundle" : index > 20 ? "long_tail" : "core",
    };
  });

  const activeVariants = products.filter((product) => product.status === "ACTIVE").flatMap((product) => product.variants);
  while (activeVariants.length < profile.activeVariants) {
    const product = products.find((candidate) => candidate.status === "ACTIVE" && candidate.category !== "bundle" && candidate.variants.length < 3 && !candidate.variants.some((variant) => variant.optionValue === "Previous vintage"));
    if (!product) break;
    const first = product.variants[0];
    product.variants.push({
      ...first,
      sourceId: `${first.sourceId}_prev`,
      title: "Previous vintage",
      optionValue: "Previous vintage",
      sku: `${first.sku}-PV`,
      price: money(first.price - 1),
      compareAtPrice: null,
    });
    activeVariants.push(product.variants[product.variants.length - 1]);
  }

  if (scenario === "quality_edge_cases") {
    const active = products.filter((product) => product.status === "ACTIVE");
    active[0].variants[0].sku = "";
    active[1].variants[0].sku = "";
    active[2].variants[0].sku = active[3].variants[0].sku;
    active[4].variants[0].price = 0;
  }

  return products;
}

function buildCollections(products) {
  const specs = [
    ["all_wine", "All Wine", () => true],
    ["red", "Red", (p) => p.category === "red"],
    ["white", "White", (p) => p.category === "white"],
    ["orange", "Orange", (p) => p.category === "orange"],
    ["chilled_red", "Chilled Red", (p) => p.category === "chilled_red"],
    ["bundles", "Bundles", (p) => p.category === "bundle"],
    ["moldova", "Moldova", (p) => p.country === "Moldova"],
    ["uruguay", "Uruguay", (p) => p.country === "Uruguay"],
    ["new_arrivals", "New Arrivals", (p) => ["recent_launch", "core"].includes(p.demandRole)],
    ["under_20", "Under GBP 20", (p) => p.variants.some((variant) => variant.price > 0 && variant.price < 20)],
  ];
  return specs.map(([sourceId, title, predicate]) => ({
    sourceId,
    title,
    handle: slugify(title),
    productSourceIds: products.filter((product) => product.status === "ACTIVE" && predicate(product)).map((product) => product.sourceId),
  }));
}

function buildCustomers(profile, rng) {
  return Array.from({ length: profile.knownCustomers }, (_, index) => {
    const region = rng.weighted(REGIONS.map((item) => ({ value: item, weight: item.weight })));
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const postcodeArea = rng.pick(region.postcodes);
    return {
      sourceId: `cust_${String(index + 1).padStart(4, "0")}`,
      firstName,
      lastName,
      email: `synthetic.customer.${String(index + 1).padStart(4, "0")}@example.com`,
      phone: null,
      acceptsMarketing: rng.chance(0.34),
      tags: [SYNTHETIC_TAG, "profile:pending", "scenario:pending"],
      defaultAddress: {
        firstName,
        lastName,
        address1: `${rng.int(1, 140)} Synthetic ${rng.pick(["Yard", "Mews", "Close", "Walk", "Lane"])}`,
        address2: rng.chance(0.18) ? `Flat ${rng.int(1, 40)}` : null,
        city: postcodeArea.replace(/[A-Z0-9 ]+$/, "").trim() || region.area,
        province: region.area,
        country: "United Kingdom",
        zip: syntheticPostcode(postcodeArea, rng),
      },
      region: region.area,
    };
  });
}

function buildOrders(profile, rng, asOf, products, customers, scenario) {
  const activeProducts = products.filter((product) => product.status === "ACTIVE");
  const customerOrderCounts = allocateCustomerOrderCounts(profile.knownCustomers, profile.nonTestOrders - profile.guestOrders, rng);
  const datedOrders = weightedOrderDates(profile.nonTestOrders + profile.testOrders, rng, asOf, profile.historyDays);
  const orders = [];
  let dateIndex = 0;
  let orderNumber = 1001;

  customers.forEach((customer, customerIndex) => {
    const count = customerOrderCounts[customerIndex] || 0;
    const customerDates = Array.from({ length: count }, () => datedOrders[dateIndex++] || randomOrderDate(rng, asOf, profile.historyDays)).sort();
    for (const placedAt of customerDates) {
      orders.push(
        buildOrder({
          sourceId: `ord_${String(orderNumber).padStart(5, "0")}`,
          orderNumber: orderNumber++,
          customer,
          placedAt,
          rng,
          products: activeProducts,
          asOf,
          isGuest: false,
          isTest: false,
          scenario,
        }),
      );
    }
  });

  for (let index = 0; index < profile.guestOrders; index += 1) {
    orders.push(
      buildOrder({
        sourceId: `ord_${String(orderNumber).padStart(5, "0")}`,
        orderNumber: orderNumber++,
        customer: null,
        placedAt: datedOrders[dateIndex++] || randomOrderDate(rng, asOf, profile.historyDays),
        rng,
        products: activeProducts,
        asOf,
        isGuest: true,
        isTest: false,
        scenario,
      }),
    );
  }

  for (let index = 0; index < profile.testOrders; index += 1) {
    orders.push(
      buildOrder({
        sourceId: `test_${String(index + 1).padStart(3, "0")}`,
        orderNumber: orderNumber++,
        customer: rng.pick(customers),
        placedAt: datedOrders[dateIndex++] || daysAgoIso(rng.int(1, 120), asOf),
        rng,
        products: activeProducts,
        asOf,
        isGuest: false,
        isTest: true,
        scenario,
      }),
    );
  }

  // Clearly marked goodwill or replacement orders that should not be hidden behind test-order filters.
  for (let index = 0; index < Math.max(3, Math.min(6, Math.round(profile.nonTestOrders * 0.004))); index += 1) {
    const order = orders.find((candidate) => !candidate.isTest && candidate.totalPrice > 0 && candidate.lineItems.length === 1);
    if (order) {
      order.tags.push(index % 2 === 0 ? "SYNTHETIC_REPLACEMENT" : "SYNTHETIC_DAMAGED_PARCEL_RESHIP");
      order.subtotalPrice = 0;
      order.totalDiscount = 0;
      order.totalShipping = 0;
      order.totalTax = 0;
      order.totalPrice = 0;
      order.financialStatus = "PAID";
      order.lineItems = order.lineItems.map((line) => ({
        ...line,
        unitPrice: 0,
        totalPrice: 0,
        discount: 0,
      }));
      order.transactions = [
        {
          kind: "SALE",
          status: "SUCCESS",
          gateway: "manual",
          amount: 0,
          currency: CURRENCY,
          processedAt: order.processedAt,
        },
      ];
    }
  }

  orders.sort((a, b) => a.processedAt.localeCompare(b.processedAt));
  const latest = orders.findLast((order) => !order.isTest);
  if (latest) {
    latest.processedAt = new Date(asOf.getTime() - 1000 * 60 * 60 * 8).toISOString();
    latest.sourceCreatedAt = latest.processedAt;
    latest.sourceUpdatedAt = latest.processedAt;
  }
  return orders;
}

function buildOrder({ sourceId, orderNumber, customer, placedAt, rng, products, asOf, isGuest, isTest, scenario }) {
  const date = new Date(placedAt);
  const dayAge = Math.max(0, Math.floor((asOf.getTime() - date.getTime()) / 86_400_000));
  const basket = buildBasket(products, rng, date);
  let subtotal = money(basket.reduce((sum, line) => sum + line.quantity * line.variant.price, 0));
  const discountCode = chooseDiscount({ customer, rng, date, subtotal });
  const totalDiscount = discountCode ? discountAmount(discountCode, subtotal) : 0;
  const totalTax = 0;
  const cancelled = !isTest && dayAge > 7 && rng.chance(0.028);
  const recent = dayAge < 4;
  const fulfilled = !cancelled && !recent && rng.chance(0.91);
  const pending = !cancelled && rng.chance(recent ? 0.18 : 0.025);
  const financialStatus = cancelled ? "VOIDED" : pending ? "PENDING" : "PAID";
  const lineItems = basket.map((line, index) => ({
    sourceId: `${sourceId}_li_${index + 1}`,
    productSourceId: line.product.sourceId,
    variantSourceId: line.variant.sourceId,
    sku: line.variant.sku,
    title: line.product.title,
    variantTitle: line.variant.title,
    quantity: line.quantity,
    unitPrice: line.variant.price,
    totalPrice: money(line.quantity * line.variant.price),
    discount: totalDiscount ? money(((line.quantity * line.variant.price) / subtotal) * totalDiscount) : 0,
  }));

  if (scenario === "quality_edge_cases" && rng.chance(0.018)) {
    lineItems.push({
      sourceId: `${sourceId}_custom`,
      productSourceId: null,
      variantSourceId: null,
      sku: "CUSTOM-TASTING-NOTE",
      title: "Synthetic custom tasting-note card",
      variantTitle: null,
      quantity: 1,
      unitPrice: 3,
      totalPrice: 3,
      discount: 0,
    });
    subtotal = money(subtotal + 3);
  }

  const shipping = discountCode === "SHIPFREE" ? 0 : shippingForMerchandise(money(subtotal - totalDiscount));
  const totalPrice = money(subtotal - totalDiscount + shipping + totalTax);

  return {
    sourceId,
    name: `#EWC${orderNumber}`,
    customerSourceId: isGuest ? null : (customer?.sourceId ?? null),
    email: isGuest ? `synthetic.guest.${sourceId}@example.com` : (customer?.email ?? null),
    currency: scenario === "quality_edge_cases" && rng.chance(0.03) ? "EUR" : CURRENCY,
    processedAt: date.toISOString(),
    sourceCreatedAt: date.toISOString(),
    sourceUpdatedAt: date.toISOString(),
    financialStatus,
    fulfillmentStatus: fulfilled ? "FULFILLED" : cancelled ? "UNFULFILLED" : rng.chance(0.08) ? "PARTIALLY_FULFILLED" : "UNFULFILLED",
    cancelledAt: cancelled ? new Date(date.getTime() + rng.int(2, 36) * 3_600_000).toISOString() : null,
    isTest,
    tags: [SYNTHETIC_TAG, `scenario:${scenario}`, isTest ? "synthetic_test_order" : "synthetic_commercial_order"],
    discountCode,
    subtotalPrice: subtotal,
    totalDiscount,
    totalShipping: shipping,
    totalTax,
    totalPrice,
    lineItems,
    transactions:
      financialStatus === "PAID"
        ? [
            {
              kind: "SALE",
              status: "SUCCESS",
              gateway: "manual",
              amount: totalPrice,
              currency: CURRENCY,
              processedAt: date.toISOString(),
            },
          ]
        : [],
    shippingLine: {
      title: "Standard UK Delivery",
      price: shipping,
      code: shipping === 0 ? "FREE_OVER_60" : "UK_STANDARD_1_3_DAY",
    },
    billingAddress: customer?.defaultAddress ?? null,
    shippingAddress: customer?.defaultAddress ?? null,
  };
}

function buildBasket(products, rng, date) {
  const month = date.getUTCMonth() + 1;
  const quantityRoll = rng.next();
  const bottleQuantity = quantityRoll < 0.38 ? 1 : quantityRoll < 0.74 ? 2 : quantityRoll < 0.89 ? 3 : rng.int(4, 9);
  const bundleProducts = products.filter((product) => product.category === "bundle");
  const useBundle = bundleProducts.length > 0 && rng.chance(month >= 11 ? 0.24 : 0.15);
  const lines = [];
  if (useBundle) {
    const bundle = weightedProduct(bundleProducts, rng, date);
    lines.push({ product: bundle, variant: bundle.variants[0], quantity: 1 });
    if (rng.chance(0.22)) {
      const extra = weightedProduct(
        products.filter((product) => product.category !== "bundle"),
        rng,
        date,
      );
      lines.push({ product: extra, variant: extra.variants[0], quantity: 1 });
    }
    return lines;
  }

  let remaining = bottleQuantity;
  while (remaining > 0) {
    const product = weightedProduct(
      products.filter((candidate) => candidate.category !== "bundle"),
      rng,
      date,
    );
    const variant = rng.chance(0.08) ? product.variants[product.variants.length - 1] : product.variants[0];
    const existing = lines.find((line) => line.variant.sourceId === variant.sourceId);
    const quantity = Math.min(remaining, rng.chance(0.72) ? 1 : rng.int(1, remaining));
    if (existing) existing.quantity += quantity;
    else lines.push({ product, variant, quantity });
    remaining -= quantity;

    if (product.category === "orange" && rng.chance(0.42) && remaining > 0) {
      const partner = weightedProduct(
        products.filter((candidate) => ["orange", "chilled_red"].includes(candidate.category)),
        rng,
        date,
      );
      lines.push({
        product: partner,
        variant: partner.variants[0],
        quantity: 1,
      });
      remaining -= 1;
    }
  }
  return lines;
}

function weightedProduct(products, rng, date) {
  const month = date.getUTCMonth() + 1;
  const ageDaysFromLaunch = Math.floor((date.getTime() - Date.UTC(2026, 4, 1)) / 86_400_000);
  return rng.weighted(
    products.map((product, index) => {
      let weight = product.demandRole === "hero" ? 12 : product.demandRole === "former_hero" ? 10 : product.demandRole === "bundle" ? 5 : product.demandRole === "long_tail" ? 1.4 : 4;
      if (product.category === "white" && month >= 5 && month <= 8) weight *= 1.35;
      if (product.category === "orange" && month >= 5 && month <= 8) weight *= 1.45;
      if (product.category === "chilled_red" && month >= 5 && month <= 8) weight *= 1.55;
      if (product.category === "bundle" && (month === 11 || month === 12)) weight *= 1.8;
      if (product.demandRole === "recent_launch") weight *= ageDaysFromLaunch > 0 ? 1.7 : 0.15;
      if (product.demandRole === "former_hero" && date >= new Date("2026-04-01T00:00:00Z")) weight *= 0.25;
      if (index === NO_RECENT_SALES_INDEX && date >= new Date("2026-04-24T00:00:00Z")) weight = 0.01;
      return { value: product, weight };
    }),
  );
}

function buildRefunds(profile, rng, asOf, orders) {
  const eligible = orders.filter((order) => !order.isTest && order.financialStatus === "PAID" && order.totalPrice > 0 && new Date(order.processedAt).getTime() < asOf.getTime() - 14 * 86_400_000);
  const selected = shuffle(eligible, rng).slice(0, Math.min(profile.refundedOrders, eligible.length));
  const multiRefundOrders = new Set(selected.slice(0, Math.max(1, profile.refundRecords - selected.length)).map((order) => order.sourceId));
  const refunds = [];
  for (const order of selected) {
    const state = createRefundState(order);
    const events = multiRefundOrders.has(order.sourceId) ? 2 : 1;
    for (let eventIndex = 0; eventIndex < events; eventIndex += 1) {
      if (state.remainingPayment <= 0) break;
      const reason = chooseRefundReason(rng);
      const refundableLines = remainingRefundableLines(order, state);
      const isFull = events === 1 && eventIndex === 0 && rng.chance(0.2);
      const shippingOnly = !isFull && state.remainingShipping > 0 && rng.chance(0.1);
      const goodwill = !isFull && !shippingOnly && rng.chance(0.08);
      let refundLineItems = [];
      let lineAmount = 0;
      let shippingAmount = 0;

      if (isFull) {
        refundLineItems = refundableLines.map((line) => ({
          orderLineItemSourceId: line.sourceId,
          quantity: line.remainingQuantity,
          subtotal: refundableLineAmount(line, line.remainingQuantity),
          restockType: shouldRestock(reason, rng) ? "RETURN" : "NO_RESTOCK",
        }));
        lineAmount = money(refundLineItems.reduce((sum, item) => sum + item.subtotal, 0));
        shippingAmount = state.remainingShipping;
      } else if (shippingOnly) {
        shippingAmount = state.remainingShipping;
      } else if (goodwill) {
        lineAmount = money(Math.min(state.remainingPayment, rng.float(3, 12)));
      } else if (refundableLines.length > 0) {
        const line = rng.pick(refundableLines);
        const lineQuantity = Math.max(1, Math.min(line.remainingQuantity, 1));
        lineAmount = refundableLineAmount(line, lineQuantity);
        refundLineItems = [
          {
            orderLineItemSourceId: line.sourceId,
            quantity: lineQuantity,
            subtotal: lineAmount,
            restockType: shouldRestock(reason, rng) ? "RETURN" : "NO_RESTOCK",
          },
        ];
      } else if (state.remainingShipping > 0) {
        shippingAmount = state.remainingShipping;
      } else {
        continue;
      }

      const amount = money(lineAmount + shippingAmount);
      if (amount <= 0 || amount - state.remainingPayment > 0.02) continue;
      const processedAt = new Date(new Date(order.processedAt).getTime() + rng.int(2, rng.chance(0.88) ? 14 : 30) * 86_400_000 + rng.int(1, 16) * 3_600_000).toISOString();
      applyRefundState(state, refundLineItems, shippingAmount, amount);
      refunds.push({
        sourceId: `ref_${order.sourceId}_${eventIndex + 1}`,
        orderSourceId: order.sourceId,
        amount,
        currency: CURRENCY,
        reason,
        processedAt,
        note: `${reason}. Synthetic refund event.`,
        notify: false,
        refundLineItems,
        shippingRefund: shippingAmount > 0 ? { amount: shippingAmount } : null,
        transactions: [
          {
            kind: "REFUND",
            status: "SUCCESS",
            gateway: "manual",
            amount,
            currency: CURRENCY,
            processedAt,
          },
        ],
        idempotencyKey: `synthetic:${order.sourceId}:refund:${eventIndex + 1}`,
      });
    }
  }
  return refunds.slice(0, profile.refundRecords);
}

function createRefundState(order) {
  return {
    remainingPayment: order.totalPrice,
    remainingShipping: order.totalShipping,
    refundedLineQuantities: new Map(),
  };
}

function remainingRefundableLines(order, state) {
  return order.lineItems
    .map((line) => ({
      ...line,
      remainingQuantity: line.quantity - (state.refundedLineQuantities.get(line.sourceId) || 0),
    }))
    .filter((line) => line.remainingQuantity > 0);
}

function refundableLineAmount(line, quantity) {
  const netLineAmount = money(line.totalPrice - line.discount);
  return money(netLineAmount * (quantity / line.quantity));
}

function applyRefundState(state, refundLineItems, shippingAmount, amount) {
  state.remainingPayment = money(Math.max(0, state.remainingPayment - amount));
  state.remainingShipping = money(Math.max(0, state.remainingShipping - shippingAmount));
  for (const item of refundLineItems) {
    state.refundedLineQuantities.set(
      item.orderLineItemSourceId,
      (state.refundedLineQuantities.get(item.orderLineItemSourceId) || 0) + item.quantity,
    );
  }
}

function buildInventory(profile, rng, variants, locations, scenario, asOf) {
  const activeVariants = variants.filter((variant) => variant.price > 0);
  const untracked = new Set(
    shuffle(activeVariants, rng)
      .slice(0, Math.max(2, Math.round(activeVariants.length * 0.08)))
      .map((variant) => variant.sourceId),
  );
  const levels = [];
  let trackedOrdinal = 0;
  for (const variant of activeVariants) {
    variant.inventoryTracked = !untracked.has(variant.sourceId);
    if (!variant.inventoryTracked) continue;
    trackedOrdinal += 1;
    const productIndex = Number(variant.productSourceId.match(/\d+/)?.[0] ?? 0) - 1;
    let available = productIndex < 3 ? rng.int(60, 180) : productIndex > 20 ? rng.int(4, 30) : rng.int(20, 80);
    if (rng.chance(0.11)) available = rng.int(1, 3);
    if ([6, 14, 22].includes(trackedOrdinal)) available = 0;
    if (trackedOrdinal === 27 || (scenario === "quality_edge_cases" && trackedOrdinal === 4)) available = -rng.int(1, 3);
    levels.push({
      sourceId: `inv_${variant.sourceId}_main`,
      variantSourceId: variant.sourceId,
      inventoryItemSourceId: `ii_${variant.sourceId}`,
      locationSourceId: locations[0].sourceId,
      available,
      committed: rng.int(0, 4),
      incoming: rng.chance(0.2) ? rng.int(6, 48) : 0,
      observedAt: asOf.toISOString(),
    });
    if (rng.chance(0.28) && available > 3) {
      levels.push({
        sourceId: `inv_${variant.sourceId}_events`,
        variantSourceId: variant.sourceId,
        inventoryItemSourceId: `ii_${variant.sourceId}`,
        locationSourceId: locations[1].sourceId,
        available: rng.int(1, Math.min(12, available)),
        committed: 0,
        incoming: 0,
        observedAt: asOf.toISOString(),
      });
    }
  }
  return levels;
}

function allocateCustomerOrderCounts(customerCount, linkedOrders, rng) {
  const oneOrderCount = Math.min(customerCount, Math.max(0, Math.round(customerCount * 0.7)));
  let repeatCount = customerCount - oneOrderCount;
  while (oneOrderCount + repeatCount * 2 > linkedOrders && repeatCount > 0) repeatCount -= 1;
  const counts = Array(customerCount).fill(0);
  const indices = shuffle(
    Array.from({ length: customerCount }, (_, index) => index),
    rng,
  );
  for (const index of indices.slice(0, oneOrderCount)) counts[index] = 1;
  for (const index of indices.slice(oneOrderCount, oneOrderCount + repeatCount)) counts[index] = 2;
  let total = counts.reduce((sum, count) => sum + count, 0);
  const repeatIndices = indices.slice(oneOrderCount, oneOrderCount + repeatCount);
  const vipIndices = repeatIndices.slice(0, Math.max(1, Math.round(customerCount * 0.02)));
  let cursor = 0;
  while (total < linkedOrders && cursor < repeatIndices.length * 20) {
    const index = cursor < vipIndices.length * 8 ? vipIndices[cursor % vipIndices.length] : repeatIndices[cursor % repeatIndices.length];
    const cap = vipIndices.includes(index) ? 15 : 4;
    if (counts[index] < cap) {
      counts[index] += 1;
      total += 1;
    }
    cursor += 1;
  }
  cursor = 0;
  while (total > linkedOrders) {
    const index = indices[cursor % indices.length];
    if (counts[index] > 1) {
      counts[index] -= 1;
      total -= 1;
    }
    cursor += 1;
  }
  while (total < linkedOrders) {
    counts[indices[cursor % indices.length]] += 1;
    total += 1;
    cursor += 1;
  }
  return counts;
}

function expandedBlueprints(totalProducts, rng) {
  const blueprints = [...PRODUCT_BLUEPRINTS];
  const countries = ["Moldova", "Uruguay", "Georgia", "Armenia", "Romania", "Croatia", "Slovenia", "Greece", "Lebanon", "Serbia"];
  const regions = ["High Valley", "North Slope", "River Plain", "Stone Terrace", "Old Orchard"];
  const producers = ["Casa Lumen", "Mica Stea", "Vatra Noua", "Field Notes Cellar", "Atelier Sud"];
  const grapes = ["Feteasca Neagra", "Kisi", "Plavina", "Malvasia", "Kadarka", "Areni Noir"];
  while (blueprints.length < totalProducts) {
    const category = rng.weighted([
      { value: "white", weight: 3 },
      { value: "red", weight: 3 },
      { value: "orange", weight: 2 },
      { value: "chilled_red", weight: 1 },
    ]);
    const country = rng.pick(countries);
    const grape = rng.pick(grapes);
    blueprints.push([category, country, rng.pick(regions), rng.pick(producers), `${rng.pick(["Lantern", "Market", "Hill", "Copper", "Sunday"])} ${grape}`, grape, rng.int(2021, 2024), rng.int(16, 34)]);
  }
  return blueprints.slice(0, totalProducts);
}

function weightedOrderDates(count, rng, asOf, historyDays) {
  const dates = [];
  const dayWeights = Array.from({ length: historyDays }, (_, daysAgo) => {
    const date = new Date(asOf.getTime() - daysAgo * 86_400_000);
    const month = date.getUTCMonth() + 1;
    const dow = date.getUTCDay();
    let weight = 1 + ((historyDays - daysAgo) / historyDays) * 0.28;
    if (month === 1) weight *= 0.74;
    if ([5, 6, 7, 8].includes(month)) weight *= 1.12;
    if ([11, 12].includes(month)) weight *= 1.56;
    if ([4, 5, 0].includes(dow)) weight *= 1.28;
    if (dow === 1) weight *= 0.72;
    if (isLaunchWeekend(date)) weight *= 2.5;
    if (daysAgo <= 90) weight *= 1.13;
    return { value: date, weight };
  });
  for (let index = 0; index < count; index += 1) {
    const day = rng.weighted(dayWeights);
    const hour = rng.weighted([
      { value: rng.int(18, 22), weight: 58 },
      { value: rng.int(12, 14), weight: 20 },
      { value: rng.int(9, 17), weight: 17 },
      { value: rng.int(0, 8), weight: 5 },
    ]);
    dates.push(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, rng.int(0, 59), rng.int(0, 59))).toISOString());
  }
  return dates.sort();
}

function randomOrderDate(rng, asOf, historyDays) {
  return daysAgoIso(rng.int(0, historyDays), asOf);
}

function plannedCounts(profile, products, variants, customers, orders, refunds, inventoryLevels) {
  return {
    products: products.length,
    activeProducts: products.filter((product) => product.status === "ACTIVE").length,
    archivedProducts: products.filter((product) => product.status === "ARCHIVED").length,
    draftProducts: products.filter((product) => product.status === "DRAFT").length,
    variants: variants.length,
    activeVariants: products.filter((product) => product.status === "ACTIVE").flatMap((product) => product.variants).length,
    collections: 10,
    customers: customers.length,
    orders: orders.length,
    nonTestOrders: orders.filter((order) => !order.isTest).length,
    testOrders: orders.filter((order) => order.isTest).length,
    guestOrders: orders.filter((order) => !order.customerSourceId && !order.isTest).length,
    lineItems: orders.reduce((sum, order) => sum + order.lineItems.length, 0),
    refundedOrders: new Set(refunds.map((refund) => refund.orderSourceId)).size,
    refunds: refunds.length,
    refundTransactions: refunds.reduce((sum, refund) => sum + refund.transactions.length, 0),
    inventoryLocations: 2,
    inventoryLevels: inventoryLevels.length,
    expectedNonTestOrders: profile.nonTestOrders,
  };
}

export function summarizeDataset(dataset) {
  const normalOrders = dataset.orders.filter((order) => !order.isTest);
  const values = normalOrders.map((order) => order.totalPrice);
  const itemCounts = normalOrders.map((order) => order.lineItems.reduce((sum, line) => sum + line.quantity, 0));
  const customerOrderCounts = new Map();
  for (const order of normalOrders) {
    if (!order.customerSourceId) continue;
    customerOrderCounts.set(order.customerSourceId, (customerOrderCounts.get(order.customerSourceId) || 0) + 1);
  }
  const positiveStock = dataset.inventoryLevels.filter((level) => level.available > 0).reduce((sum, level) => sum + level.available, 0);
  const negativeStockMagnitude = Math.abs(dataset.inventoryLevels.filter((level) => level.available < 0).reduce((sum, level) => sum + level.available, 0));
  return {
    orderValue: {
      mean: average(values),
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      p90: quantile(values, 0.9),
    },
    basket: {
      averageItems: average(itemCounts),
      medianItems: quantile(itemCounts, 0.5),
      singleItemShare: percent(itemCounts.filter((count) => count === 1).length, itemCounts.length),
      multiItemShare: percent(itemCounts.filter((count) => count > 1).length, itemCounts.length),
      largeBasketShare: percent(itemCounts.filter((count) => count >= 4).length, itemCounts.length),
      freeDeliveryShare: percent(normalOrders.filter((order) => order.totalShipping === 0).length, normalOrders.length),
      discountedOrderShare: percent(normalOrders.filter((order) => order.discountCode).length, normalOrders.length),
    },
    customers: {
      knownCustomerShare: percent(normalOrders.filter((order) => order.customerSourceId).length, normalOrders.length),
      guestOrderShare: percent(normalOrders.filter((order) => !order.customerSourceId).length, normalOrders.length),
      repeatCustomerRate: percent([...customerOrderCounts.values()].filter((count) => count > 1).length, dataset.customers.length),
      vipCustomers: [...customerOrderCounts.values()].filter((count) => count >= 8).length,
    },
    refunds: {
      refundedOrderIncidence: percent(new Set(dataset.refunds.map((refund) => refund.orderSourceId)).size, normalOrders.length),
      totalRefundedAmount: money(dataset.refunds.reduce((sum, refund) => sum + refund.amount, 0)),
      transactionCoverage: percent(dataset.refunds.filter((refund) => refund.transactions.some((transaction) => transaction.status === "SUCCESS")).length, dataset.refunds.length),
    },
    inventory: {
      trackedVariantShare: percent(dataset.variants.filter((variant) => variant.inventoryTracked).length, dataset.variants.length),
      positiveStock,
      zeroStockVariants: new Set(dataset.inventoryLevels.filter((level) => level.available === 0).map((level) => level.variantSourceId)).size,
      negativeStockMagnitude,
      lowStockVariants: new Set(dataset.inventoryLevels.filter((level) => level.available > 0 && level.available <= 3).map((level) => level.variantSourceId)).size,
    },
    activeSellingDays: new Set(normalOrders.map((order) => order.processedAt.slice(0, 10))).size,
  };
}

function productDescription({ category, country, region, producer, title, grape, vintage, rng }) {
  const notes = shuffle(["salt", "quince", "redcurrant", "wild herb", "lemon peel", "smoke", "sour cherry", "pear skin", "almond", "tea leaf", "cranberry", "wet stone"], rng).slice(0, rng.int(3, 5));
  const method = category === "orange" ? "skins left in the vat just long enough to add grip and spice" : category === "chilled_red" ? "a short, bright ferment built for a light chill" : "native yeast fermentation followed by quiet ageing";
  return `<p><strong>${title}</strong> comes from ${producer} in ${region}, ${country}. The ${vintage} is ${grape}, farmed with minimal sprays on small mixed plots where yield matters less than tension.</p><p>${method}; expect ${notes.join(", ")}. Serve at ${category === "red" ? "14-16C" : "9-12C"} with ${rng.pick(["grilled vegetables", "fried potatoes and aioli", "charred chicken", "hard cheese", "tomato salads", "mushroom toast"])}.</p><p>We bought it for the way it makes an unfamiliar place feel easy to pour without sanding off its edges.</p>`;
}

function syntheticTags(runId, profile, scenario) {
  return [SYNTHETIC_TAG, `seed_run:${runId}`, `scenario:${scenario}`, `profile:${profile}`];
}

function skuFor({ category, country, vintage, index, isBundle, caseVariant }) {
  if (isBundle) return `EWC-BND-${String(index + 1).padStart(2, "0")}`;
  const categoryCode = { white: "WH", red: "RD", orange: "OR", chilled_red: "CR" }[category] || "WN";
  const countryCode = String(country).slice(0, 2).toUpperCase();
  return `EWC-${countryCode}-${categoryCode}-${vintage}-${caseVariant ? "6PK" : "750"}`;
}

function productType(category) {
  return (
    {
      white: "White Wine",
      red: "Red Wine",
      orange: "Orange Wine",
      chilled_red: "Chilled Red",
      bundle: "Wine Bundle",
    }[category] || "Wine"
  );
}

function chooseDiscount({ customer, rng, date, subtotal }) {
  if (rng.next() > 0.105) return null;
  const month = date.getUTCMonth() + 1;
  if (subtotal < 60 && rng.chance(0.25)) return "SHIPFREE";
  if (customer && rng.chance(0.35)) return "CLUB15";
  if ([1, 2].includes(month)) return "WINTER12";
  if (rng.chance(0.45)) return "WELCOME10";
  return "DISCOVER10";
}

function discountAmount(code, subtotal) {
  if (code === "SHIPFREE") return 0;
  if (code === "CLUB15") return money(subtotal * 0.15);
  if (code === "WINTER12") return money(subtotal * 0.12);
  return money(subtotal * 0.1);
}

function chooseRefundReason(rng) {
  return rng.weighted([
    { value: "Bottle damaged in transit", weight: 32 },
    { value: "Parcel lost or delivery failed", weight: 20 },
    { value: "Incorrect bottle sent", weight: 17 },
    { value: "Duplicate order", weight: 8 },
    { value: "Customer cancelled before dispatch", weight: 10 },
    { value: "Unopened bottles returned", weight: 8 },
    { value: "Partial goodwill refund for late delivery", weight: 5 },
  ]);
}

function shouldRestock(reason, rng) {
  if (reason.includes("damaged") || reason.includes("lost") || reason.includes("late")) return false;
  return rng.chance(0.7);
}

function isLaunchWeekend(date) {
  const yyyyMmDd = date.toISOString().slice(0, 10);
  return ["2025-11-22", "2026-03-07", "2026-05-16"].includes(yyyyMmDd);
}

function syntheticPostcode(area, rng) {
  const first = area.match(/[A-Z]{1,2}\d{1,2}/)?.[0] || "EC1";
  return `${first} ${rng.int(1, 9)}${rng.pick(["AA", "BD", "LT", "QX", "ZR"])}`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function daysAgoIso(days, asOf) {
  return new Date(asOf.getTime() - days * 86_400_000).toISOString();
}

function shuffle(values, rng) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = rng.int(0, index);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function average(values) {
  if (!values.length) return 0;
  return money(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percent(numerator, denominator) {
  if (!denominator) return 0;
  return money((numerator / denominator) * 100);
}

function createRunId(input) {
  return `synth_${crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12)}`;
}
