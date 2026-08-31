/**
 * 宇都宮市中心部の道路データをOverpass APIから取得して fixtures/osm/utsunomiya.osm.json に保存
 *
 * Usage: npx tsx scripts/fetch-osm.ts
 */

import { writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 宇都宮駅周辺 約3km四方
const CENTER_LAT = 36.5592;
const CENTER_LON = 139.8985;
const RADIUS_M = 3000;

const query = `
[out:json][timeout:30];
(
  way(around:${RADIUS_M},${CENTER_LAT},${CENTER_LON})[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service)$"];
  relation(around:${RADIUS_M},${CENTER_LAT},${CENTER_LON})[type=restriction];
);
out body;
>;
out skel qt;
`;

async function main() {
  console.log("Fetching OSM data for Utsunomiya area...");
  console.log(`Center: ${CENTER_LAT}, ${CENTER_LON}, Radius: ${RADIUS_M}m`);

  const url = "https://overpass-api.de/api/interpreter";
  const resp = await fetch(url, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!resp.ok) {
    console.error(`Overpass API error: ${resp.status} ${resp.statusText}`);
    const body = await resp.text();
    console.error(body.slice(0, 500));
    process.exit(1);
  }

  const data = await resp.json();
  const elements = data.elements || [];
  console.log(`Received ${elements.length} elements`);

  const nodes = elements.filter((e: any) => e.type === "node").length;
  const ways = elements.filter((e: any) => e.type === "way").length;
  const rels = elements.filter((e: any) => e.type === "relation").length;
  console.log(`  Nodes: ${nodes}, Ways: ${ways}, Relations: ${rels}`);

  const outPath = join(__dirname, "../fixtures/osm/utsunomiya.osm.json");
  await writeFile(outPath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`Saved to ${outPath}`);
}

main().catch(console.error);
