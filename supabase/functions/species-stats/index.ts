import { withSupabase } from "npm:@supabase/server@1.4.1";

const SPECIES_PATTERN = /^[A-Z][A-Za-z0-9]{0,31}$/;

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": status === 200
        ? "public, max-age=60, stale-while-revalidate=300"
        : "no-store",
      ...headers,
    },
  });
}

export default {
  fetch: withSupabase({ auth: "publishable:default" }, async (req, ctx) => {
    if (req.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    }

    const url = new URL(req.url);
    const speciesValues = url.searchParams.getAll("species");
    const formatValues = url.searchParams.getAll("format");
    const precise = formatValues.length === 1 && formatValues[0] === "precise";
    const hasUnknownParameter = [...url.searchParams.keys()].some((key) => key !== "species" && key !== "format");

    if (speciesValues.length !== 1
      || formatValues.length > 1
      || (formatValues.length === 1 && !precise)
      || hasUnknownParameter
      || !SPECIES_PATTERN.test(speciesValues[0])) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    const { data, error } = await ctx.supabaseAdmin.rpc(precise ? "get_species_stats_precise" : "get_species_stats", {
      p_species: speciesValues[0],
    });

    if (error) {
      console.error("species-stats rpc failed", {
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return jsonResponse({ error: "server_error" }, 500);
    }

    const result = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
    return jsonResponse({ data: result });
  }),
};
