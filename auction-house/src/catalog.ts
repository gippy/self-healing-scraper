export const BRAND = 'Silicon & Gavel';

/** Raise this when the catalog changes; on startup a saved auction from another version is cleared and reseeded. */
export const CATALOG_VERSION = 'gpu-1';

/** The folder under `public/images` that holds this catalog's product photos. */
export const IMAGE_FOLDER = 'gpu';

export type Category = { slug: string; name: string };

export type CatalogItem = { title: string; description: string; startingBid: number };

export const CATEGORIES: Category[] = [
  { slug: 'flagship-gaming', name: 'Flagship Gaming' },
  { slug: 'datacenter', name: 'Datacenter Accelerators' },
  { slug: 'workstation', name: 'Workstation Cards' },
  { slug: 'retro', name: 'Retro & Collectible' },
  { slug: 'mining-survivors', name: 'Mining Survivors' },
  { slug: 'low-profile', name: 'Mini & Low-Profile' },
];

/** The file name of an item's product photo, from its title: `Thermal Throttle TX-9000 24GB` → `thermal-throttle-tx-9000-24gb`. */
export function getItemSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// What new lots are made of: every category has its own pool of items. Titles are unique across the catalog.
export const CATALOG: Record<string, CatalogItem[]> = {
  'flagship-gaming': [
    { title: 'Thermal Throttle TX-9000 24GB', description: 'Four slots wide, three fans, one very warm room. Box included.', startingBid: 1450 },
    { title: 'Framerate Fury X 16GB', description: 'Runs every game at max settings and your power bill at max too.', startingBid: 980 },
    { title: 'Raytrace Royale 20GB, Liquid Cooled', description: 'Closed-loop cooler, quiet under load, slightly loud under scrutiny.', startingBid: 1250 },
    { title: 'Overclock Overlord OC 24GB', description: 'Factory overclocked. Owner overclocked further. Still stable, mostly.', startingBid: 1600 },
    { title: 'Pixel Pusher Ultra 16GB, White Edition', description: 'All-white shroud for builds that are mostly about photos.', startingBid: 890 },
    { title: 'Shader Storm 12GB', description: 'Great at 1440p. Bought for gaming, used for spreadsheets.', startingBid: 520 },
    { title: 'Ludicrous Mode LM-80 32GB', description: 'Needs a 1200 W supply and a long talk with your landlord.', startingBid: 2200 },
    { title: 'Frame Gen Phantom 16GB', description: 'Generates three frames for every real one. Feels fast anyway.', startingBid: 760 },
    { title: 'RGB Rainbow Reaper 12GB', description: '128 lighting zones and an app that needs an account.', startingBid: 480 },
    { title: 'Benchmark Baron 24GB, Open Box', description: 'Ran one benchmark, posted the score, went back in the box.', startingBid: 1350 },
    { title: 'Twin Turbine TT-70 12GB', description: 'Blower cooler that sounds like a hair dryer with ambitions.', startingBid: 430 },
    { title: 'Launch Day Unicorn 24GB', description: 'Bought at launch after a 9-hour queue. Seller needs closure.', startingBid: 1800 },
    { title: 'Melted Connector Survivor 24GB', description: 'New power cable included. Old one framed separately.', startingBid: 1100 },
    { title: 'Sag Bracket Special 20GB', description: 'So heavy it ships with its own support pillar.', startingBid: 990 },
    { title: 'Quiet Mode Qx 16GB', description: 'Zero-RPM fans at idle, jet engine at minute three.', startingBid: 690 },
  ],
  datacenter: [
    { title: 'H-Adjacent 80GB, One Training Run', description: 'Slightly used for one training run. The model was fine. Mostly.', startingBid: 18000 },
    { title: 'Tensor Titan TT-100 80GB', description: 'Passive cooling, so bring your own hurricane.', startingBid: 22000 },
    { title: 'Inference Engine IE-40 48GB', description: 'Serves tokens all day. Has opinions about batch size.', startingBid: 7500 },
    { title: 'Superchip-Ish SX 94GB, Mezzanine Module', description: 'Needs a very specific board, which is not included.', startingBid: 26000 },
    { title: 'Attention Is All It Had 141GB', description: 'Enough memory for a big context window and a bigger invoice.', startingBid: 34000 },
    { title: 'Matrix Multiplier MM-8 Eight-Pack', description: 'Eight accelerator modules on one baseboard. Forklift recommended.', startingBid: 39000 },
    { title: 'Spot Instance Refugee 80GB', description: 'Pulled from a cloud that kept preempting it. Now free to roam.', startingBid: 16500 },
    { title: 'Liquid-Cooled LLM Lifter 120GB', description: 'Cold plate attached. Coolant not included, puddle optional.', startingBid: 29000 },
    { title: 'Bulk Batch BB-32 32GB', description: 'Older generation, still faster than your laptop at everything.', startingBid: 2400 },
    { title: 'Seed-Round Special 80GB', description: 'Bought with a seed round, sold with a pivot.', startingBid: 15000 },
    { title: 'Evals Pending EP-80 80GB', description: 'Trained something important. Results coming soon.', startingBid: 17500 },
    { title: 'Datacenter Pull, Thermal Paste Crusty 40GB', description: 'Pulled from a rack in 2024. Thermal paste is vintage.', startingBid: 6200 },
    { title: 'Waitlist Skipper WS-96 96GB', description: 'You would wait eight months for this. Or bid now.', startingBid: 24000 },
    { title: 'Sparse Model Sparrow 24GB', description: 'Small, efficient and pretends it is a big model.', startingBid: 3100 },
    { title: 'Fine-Tune Friendly FT-48 48GB', description: 'Just enough memory for that one LoRA you keep promising.', startingBid: 5400 },
  ],
  workstation: [
    { title: 'CAD Commander CC-48 48GB', description: 'Certified drivers, so your 3D models crash in a supported way.', startingBid: 3800 },
    { title: 'Render Farmhand RF-24 24GB', description: 'Single-slot blower. Rendered three feature films and a cat video.', startingBid: 1900 },
    { title: 'Viewport Virtuoso VV-16 16GB', description: 'Spins huge assemblies smoothly. Sales demo unit.', startingBid: 1100 },
    { title: 'ECC Everything E-32 32GB', description: 'Error-correcting memory for people who hate surprises.', startingBid: 2600 },
    { title: 'Simulation Station SS-64 64GB', description: 'Fluid dynamics, crash tests and the occasional weather model.', startingBid: 5200 },
    { title: 'Color Grader Pro 20GB', description: 'Ten-bit output. Makes every film look teal and orange.', startingBid: 1450 },
    { title: 'Quad Display Quill 8GB', description: 'Drives four monitors for traders who need more red and green.', startingBid: 340 },
    { title: 'Blower Bros Duo, Pair of 24GB', description: 'Two matched blower cards. Stack them, ignore the noise.', startingBid: 3300 },
    { title: 'Studio Silent S-12 12GB', description: 'Passive heatsink for music studios that hate fans.', startingBid: 780 },
    { title: 'Architect Edition AE-24 24GB', description: 'Came with a building. The building stayed.', startingBid: 2100 },
    { title: 'Mid-Tower Muse 16GB', description: 'Workstation card in a gamer card body. Midlife crisis.', startingBid: 950 },
    { title: 'Medical Imaging MI-48 48GB', description: 'Renders scans in real time. Retired from hospital duty.', startingBid: 4300 },
    { title: 'VFX Veteran 32GB', description: 'Pulled from a render node after rendering 400 explosions.', startingBid: 2350 },
    { title: 'Compute Clerk CC-10 10GB', description: 'Reliable, boring and loved by IT departments.', startingBid: 520 },
    { title: 'Dual-Slot Diplomat 40GB', description: 'Fits in any chassis and gets along with every driver.', startingBid: 3050 },
  ],
  retro: [
    { title: 'Pass-Through 3D Accelerator 4MB', description: 'Loopback cable included. Made polygons a big deal in 1997.', startingBid: 180 },
    { title: 'AGP Legend 128MB', description: 'Beige box era. Still smells like a LAN party.', startingBid: 95 },
    { title: 'Dual-Head Dreamer 64MB', description: 'Two VGA ports, for the first person on your street with two monitors.', startingBid: 70 },
    { title: 'First Programmable Shader Card 64MB', description: 'Historic. Ran a water demo that made people gasp.', startingBid: 240 },
    { title: 'Polygon Pioneer 12MB', description: 'Original box, manual and a demo CD of a game you loved.', startingBid: 210 },
    { title: 'ISA Graphics Adapter, 256KB', description: 'Sixteen colors at once. Pure luxury.', startingBid: 65 },
    { title: 'Shadow Era Sentinel 256MB', description: 'The card that first ran that one shooter at playable rates.', startingBid: 120 },
    { title: 'Mid-2000s Space Heater 512MB', description: 'Dual-slot pioneer. Heated a dorm room for four winters.', startingBid: 85 },
    { title: 'Bridge Cable Twins, Linked Pair', description: 'Two linked cards that were faster in exactly three games.', startingBid: 140 },
    { title: 'Prototype Board, Hand-Labeled', description: 'Engineering sample with a sticky note that says "do not ship".', startingBid: 390 },
    { title: 'Silicon Commemorative Die, Framed', description: 'A real GPU die in a shadow box. Runs nothing, looks great.', startingBid: 160 },
    { title: 'Workstation Wonder 1999 32MB', description: 'Professional OpenGL card from when 32 MB was enormous.', startingBid: 75 },
    { title: 'Passive Pioneer 32MB', description: 'No fan at all. Survived on optimism and airflow.', startingBid: 45 },
    { title: 'Laptop Graphics Module 1GB', description: 'Laptop graphics module, removed from a laptop that weighed 5 kg.', startingBid: 55 },
    { title: 'Golden Sample GS 1GB, Signed', description: 'Signed by an overclocking champion. Signature not overclocked.', startingBid: 310 },
  ],
  'mining-survivors': [
    { title: 'Ex-Mining Workhorse 8GB, Fans Replaced', description: 'Ran 24/7 for two years. Fans are new, the soul is tired.', startingBid: 150 },
    { title: 'Undervolted Since Birth 8GB', description: 'Spent its whole life at 70 percent power. Very calm.', startingBid: 180 },
    { title: 'Rig Pull Six-Pack, 6 x 6GB', description: 'Six identical cards from one mining frame. Riser cables included.', startingBid: 420 },
    { title: 'Headless Hasher 4GB, No Display Outputs', description: 'Mining edition with no video ports. A true minimalist.', startingBid: 90 },
    { title: 'Memory Junction Hero 10GB', description: 'New thermal pads, memory runs cool, seller swears.', startingBid: 330 },
    { title: 'Bitter Bear Market Special 12GB', description: 'Bought at the top, sold at the bottom. Works great.', startingBid: 260 },
    { title: 'Open Frame Veteran 8GB', description: 'Never lived in a case. Has seen sunlight and dust.', startingBid: 130 },
    { title: 'Hash Rate Hustler 11GB', description: 'Once paid for itself in eight months. Then it did not.', startingBid: 240 },
    { title: 'Farm Retiree, Lightly Dusty 16GB', description: 'Retired from a farm upstate. Great with families.', startingBid: 390 },
    { title: 'Thermal Pad Transplant 8GB', description: 'Repasted, repadded and repurposed for gaming.', startingBid: 170 },
    { title: 'Proof of Work Pal 6GB', description: 'Did a lot of work. Has very little proof.', startingBid: 95 },
    { title: 'Riser Cable Romantic 4GB', description: 'Comes with a tangle of USB risers and a memory of better days.', startingBid: 80 },
    { title: 'Merge Day Orphan 12GB', description: 'Became unemployed overnight. Looking for a gaming home.', startingBid: 290 },
    { title: 'Heat Lamp Edition 8GB', description: 'Kept a garage warm through two winters.', startingBid: 120 },
    { title: 'Bulk Lot of Loose Fans', description: 'Forty GPU fans in a bag. Some of them spin.', startingBid: 60 },
  ],
  'low-profile': [
    { title: 'Half-Height Hero 8GB', description: 'Fits in tiny office PCs and makes them suddenly fun.', startingBid: 210 },
    { title: 'Single-Slot Sprinter 6GB', description: 'Bus-powered, no cables, no drama.', startingBid: 160 },
    { title: 'ITX Inferno 12GB', description: 'Short card, big fan, small case that gets very warm.', startingBid: 450 },
    { title: 'Home Server Helper 4GB', description: 'Transcodes your movies at 3 am without complaint.', startingBid: 95 },
    { title: 'Edge Inference Stick 8GB', description: 'An accelerator the size of a USB drive. Runs small models.', startingBid: 140 },
    { title: 'Fanless Phantom 4GB', description: 'Totally silent. Heatsink weighs more than the card.', startingBid: 110 },
    { title: 'Tiny Tensor TT-2 16GB', description: 'Low-profile accelerator for one rack unit of ambition.', startingBid: 680 },
    { title: 'Shoebox Build Special 8GB', description: 'For people who put a gaming PC in a shoebox on purpose.', startingBid: 230 },
    { title: 'Kiosk Card K-2 2GB', description: 'Drives two airport displays. Has seen many departures.', startingBid: 40 },
    { title: 'Living Room Lite 6GB', description: 'Quiet enough for movie nights, strong enough for co-op.', startingBid: 190 },
    { title: 'Micro Rig Marvel 10GB', description: 'Ran a whole LAN party from a backpack.', startingBid: 320 },
    { title: 'Single-Fan Sweetheart 8GB', description: 'One fan, one job, one happy owner.', startingBid: 200 },
    { title: 'Low-Profile Lab Card 12GB', description: 'From a university lab. Ran one grad student’s thesis.', startingBid: 360 },
    { title: 'Bracketless Bargain 4GB', description: 'Works fine. Bracket went missing in 2019.', startingBid: 50 },
    { title: 'Display Port Dozen, 12 Outputs', description: 'Twelve mini outputs on a tiny card. Video walls love it.', startingBid: 540 },
  ],
};

/** Every catalog item, in category order. */
export function getCatalogItems(): CatalogItem[] {
  return CATEGORIES.flatMap((category) => CATALOG[category.slug] ?? []);
}
