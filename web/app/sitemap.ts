import type { MetadataRoute } from "next";

const SITE = process.env.SITE_URL ?? "https://recall-tracer.onrender.com";
const PAGES = ["/outbreak", "/notice", "/incident", "/incident/L-204", "/history", "/records", "/real", "/agent"];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: SITE + p }));
}
