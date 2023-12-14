import type { ProductListingPage } from "../../commerce/types.ts";
import { SortOption } from "../../commerce/types.ts";
import type { AppContext } from "../mod.ts";
import {
  getVariations,
  MAXIMUM_REQUEST_QUANTITY,
} from "../utils/getVariations.ts";
import { GetURL, Hotsite, Search } from "../utils/graphql/queries.ts";
import {
  GetUrlQuery,
  GetUrlQueryVariables,
  HotsiteQuery,
  HotsiteQueryVariables,
  ProductFragment,
  ProductSortKeys,
  SearchQuery,
  SearchQueryVariables,
  SortDirection,
} from "../utils/graphql/storefront.graphql.gen.ts";
import { parseHeaders } from "../utils/parseHeaders.ts";
import { FILTER_PARAM, toFilters, toProduct } from "../utils/transform.ts";
import { Filters } from "./productList.ts";

export type Sort =
  | "NAME:ASC"
  | "NAME:DESC"
  | "RELEASE_DATE:DESC"
  | "PRICE:ASC"
  | "PRICE:DESC"
  | "DISCOUNT:DESC"
  | "SALES:DESC";

export const SORT_OPTIONS: SortOption[] = [
  { value: "NAME:ASC", label: "Nome A-Z" },
  { value: "NAME:DESC", label: "Nome Z-A" },
  { value: "RELEASE_DATE:DESC", label: "Lançamentos" },
  { value: "PRICE:ASC", label: "Menores Preços" },
  { value: "PRICE:DESC", label: "Maiores Preços" },
  { value: "DISCOUNT:DESC", label: "Maiores Descontos" },
  { value: "SALES:DESC", label: "Mais Vendidos" },
];

type SortValue = `${ProductSortKeys}:${SortDirection}`;
export interface Props {
  /**
   * @title Count
   * @description Number of products to display
   * @maximum 50
   * @default 12
   */
  limit?: number;

  /** @description Types of operations to perform between query terms */
  operation?: "AND" | "OR";

  /**
   * @ignore
   */
  page: number;

  /**
   * @title Sorting
   */
  sort?: Sort;

  /**
   * @description overides the query term
   */
  query?: string;

  /**
   * @title Only Main Variant
   * @description Toggle the return of only main variants or all variations separeted.
   */
  onlyMainVariant?: boolean;

  filters?: Filters;

  /** @description Retrieve variantions for each product. */
  getVariations?: boolean;
}

const OUTSIDE_ATTRIBUTES_FILTERS = ["precoPor"];

const filtersFromParams = (searchParams: URLSearchParams) => {
  const mapped = searchParams.getAll(FILTER_PARAM).reduce((acc, value) => {
    const test = /.*:.*/;

    // todo validar
    const [field, val] = test.test(value)
      ? value.split(":")
      : value.split("__");

    if (OUTSIDE_ATTRIBUTES_FILTERS.includes(field)) return acc;

    if (!acc.has(field)) acc.set(field, []);
    acc.get(field)?.push(val);
    return acc;
  }, new Map<string, string[]>());

  const filters: Array<{ field: string; values: string[] }> = [];
  for (const [field, values] of mapped.entries()) {
    filters.push({ field, values });
  }

  return filters;
};

/**
 * @title Wake Integration
 * @description Product Listing Page loader
 */
const searchLoader = async (
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<ProductListingPage | null> => {
  // get url from params
  const url = new URL(req.url).pathname === "/live/invoke"
    ? new URL(req.headers.get("referer") ?? req.url)
    : new URL(req.url);

  const { storefront } = ctx;

  const headers = parseHeaders(req.headers);

  const limit = Number(url.searchParams.get("tamanho") ?? props.limit ?? 12);

  const filters = filtersFromParams(url.searchParams) ?? props.filters;
  const sort = (url.searchParams.get("sort") as SortValue | null) ??
    (url.searchParams.get("ordenacao") as SortValue | null) ??
    props.sort ??
    "SALES:DESC";
  const page = props.page ?? Number(url.searchParams.get("page")) ??
    Number(url.searchParams.get("pagina")) ?? 0;
  const query = props.query ?? url.searchParams.get("busca");
  const operation = props.operation ?? "AND";

  const [sortKey, sortDirection] = sort.split(":") as [
    ProductSortKeys,
    SortDirection,
  ];

  const onlyMainVariant = props.onlyMainVariant ?? true;
  const [minimumPrice, maximumPrice] =
    url.searchParams.getAll("filtro")?.find((i) => i.startsWith("precoPor"))
      ?.split(":")[1]?.split(";").map(Number) ??
      url.searchParams.get("precoPor")?.split(";").map(Number) ?? [];

  const offset = page <= 1 ? 0 : (page - 1) * limit;

  const urlData = await storefront.query<GetUrlQuery, GetUrlQueryVariables>({
    variables: {
      url: url.pathname,
    },
    ...GetURL,
  }, {
    headers,
  });

  const isHotsite = urlData.uri?.kind === "HOTSITE";

  const comoonParams = {
    sortDirection,
    sortKey,
    filters,
    limit: Math.min(limit, MAXIMUM_REQUEST_QUANTITY),
    offset,
    onlyMainVariant,
    minimumPrice,
    maximumPrice,
  };

  if (!query && !isHotsite) return null;

  const data = isHotsite
    ? await storefront.query<HotsiteQuery, HotsiteQueryVariables>({
      variables: {
        ...comoonParams,
        url: url.pathname,
      },
      ...Hotsite,
    })
    : await storefront.query<SearchQuery, SearchQueryVariables>({
      variables: {
        ...comoonParams,
        query,
        operation,
      },
      ...Search,
    });

  const products = data?.result?.productsByOffset?.items ?? [];

  const nextPage = new URLSearchParams(url.searchParams);
  const previousPage = new URLSearchParams(url.searchParams);

  const hasNextPage = Boolean(
    (data?.result?.productsByOffset?.totalCount ?? 0) %
      (data?.result?.productsByOffset?.pageSize ?? 0),
  );

  const hasPreviouePage = page > 1;

  if (hasNextPage) {
    nextPage.set("page", (page + 1).toString());
  }

  if (hasPreviouePage) {
    previousPage.set("page", (page - 1).toString());
  }

  const productIDs = products.map((i) => i?.productId);

  const variations = props.getVariations
    ? await getVariations(storefront, productIDs, headers, url)
    : [];

  const itemListElement: ProductListingPage["breadcrumb"]["itemListElement"] =
    data?.result?.breadcrumbs?.map((b, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: b!.link!,
      name: b!.text!,
    })) ?? [];

  return {
    "@type": "ProductListingPage",
    filters: toFilters(data?.result?.aggregations, { base: url }),
    pageInfo: {
      nextPage: hasPreviouePage ? `?${nextPage}` : undefined,
      previousPage: hasNextPage ? `?${previousPage}` : undefined,
      currentPage: data?.result?.productsByOffset?.page ?? 1,
      records: data?.result?.productsByOffset?.totalCount,
      recordPerPage: limit,
    },
    sortOptions: SORT_OPTIONS,
    breadcrumb: {
      "@type": "BreadcrumbList",
      itemListElement,
      numberOfItems: itemListElement.length,
    },
    products: products
      ?.filter((p): p is ProductFragment => Boolean(p))
      .map((variant) => {
        const productVariations = variations?.filter((v) =>
          v.inProductGroupWithID === variant.productId
        );

        return toProduct(variant, { base: url }, productVariations);
      }),
  };
};

export default searchLoader;
