export const BRAND = 'Gavel & Glitch Auctions';

export type Category = { slug: string; name: string };

export type CatalogItem = { title: string; description: string; startingBid: number };

export const CATEGORIES: Category[] = [
  { slug: 'gadgets', name: 'Gadgets & Gizmos' },
  { slug: 'home-office', name: 'Home & Office' },
  { slug: 'collectibles', name: 'Collectibles' },
  { slug: 'wearables', name: 'Wearables' },
  { slug: 'music', name: 'Music & Audio' },
  { slug: 'outdoors', name: 'Outdoors' },
];

// What new lots are made of: every category has its own pool of items.
export const CATALOG: Record<string, CatalogItem[]> = {
  gadgets: [
    { title: 'Vintage Rubber Duck Debugger', description: 'Squeak intact. Has heard every excuse since 1999.', startingBid: 24 },
    { title: 'Self-Stirring Coffee Mug, Slightly Possessed', description: 'Stirs on its own schedule. Mostly clockwise.', startingBid: 18 },
    { title: 'USB Pet Rock with Firmware 2.0', description: 'Does nothing, now with release notes.', startingBid: 12 },
    { title: 'Bluetooth Toaster, Pairs Eventually', description: 'Toasts evenly once it finds your phone.', startingBid: 59 },
    { title: 'Retro Pocket Calculator, Solar', description: 'Works in daylight and in strong opinions.', startingBid: 22 },
    { title: 'Noise-Cancelling Earmuffs for Meetings', description: 'Cancels noise and most action items.', startingBid: 45 },
    { title: 'Smart Plant Pot That Judges You', description: 'Reminds you to water it in a disappointed tone.', startingBid: 38 },
    { title: 'Mechanical Keyboard, Extremely Clicky', description: 'Your neighbors will know when you are productive.', startingBid: 89 },
    { title: 'Drone with Fear of Heights', description: 'Hovers confidently at knee level.', startingBid: 120 },
    { title: 'Label Maker, Pre-Loaded with "Misc"', description: 'Organize everything into one drawer.', startingBid: 27 },
  ],
  'home-office': [
    { title: 'Standing Desk for Sitting', description: 'Motorized, quiet and solid oak. It goes up, but mostly it stays down.', startingBid: 1299 },
    { title: 'Ergonomic Chair, Previously Owned by a CFO', description: 'Leans back further than the budget allows.', startingBid: 340 },
    { title: 'Inbox Zero Paperweight', description: 'Heavy enough to hold down 4,000 unread emails.', startingBid: 16 },
    { title: 'Whiteboard with Unerasable Architecture Diagram', description: 'Someone wrote "DO NOT ERASE" in 2019. We did not.', startingBid: 75 },
    { title: 'Desk Lamp Shaped Like a Semicolon', description: 'A warm light shaped like the character you forgot.', startingBid: 64 },
    { title: 'Cable Drawer, Contents Unknown', description: 'At least one cable fits something you own.', startingBid: 9 },
    { title: 'Monitor Arm with Strong Opinions', description: 'Holds any screen at exactly the wrong height.', startingBid: 85 },
    { title: 'Wall Clock That Runs on Sprint Time', description: 'Every hour takes two weeks.', startingBid: 33 },
    { title: 'Bookshelf of Unread Tech Books', description: 'Spines uncracked, intentions intact.', startingBid: 140 },
    { title: 'Office Plant, Plastic, Thriving', description: 'The only plant to survive the reorg.', startingBid: 21 },
  ],
  collectibles: [
    { title: 'First Edition Error Message, Framed', description: '"Something went wrong." Museum-grade matting.', startingBid: 95 },
    { title: 'Signed Off-by-One Socks', description: 'Three socks per pair, signed on the third.', startingBid: 14 },
    { title: 'Original Merge Conflict Mug', description: 'Keeps both your coffee and theirs warm.', startingBid: 19 },
    { title: 'Limited Floppy Disk, Contains One Meme', description: 'Read-only. Like most memes.', startingBid: 42 },
    { title: 'Commemorative Coin from the Great Outage', description: 'Minted the day the status page went green again.', startingBid: 60 },
    { title: 'Mint Condition Dial-Up Modem', description: 'Original handshake sound, never connected.', startingBid: 55 },
    { title: 'Trading Card: Legendary Senior Engineer', description: 'Rare holographic. Ability: "It depends."', startingBid: 30 },
    { title: 'Snow Globe with Tiny Data Center', description: 'Shake to simulate a cooling failure.', startingBid: 28 },
    { title: 'Autographed Printout of a Stack Trace', description: '412 lines, signed on the last frame.', startingBid: 48 },
    { title: 'Antique Fax Machine, Still Sending', description: 'Has been sending the same page since Tuesday.', startingBid: 110 },
  ],
  wearables: [
    { title: 'Hand-Knitted Infinite Loop Scarf', description: 'Knitted in one continuous round. There is no end.', startingBid: 54 },
    { title: 'Legacy Code Hard Hat', description: 'For refactoring files older than the intern.', startingBid: 27 },
    { title: 'Hoodie with Built-In Do Not Disturb', description: 'Hood up means status: busy.', startingBid: 49 },
    { title: 'Smartwatch That Only Tells Stand-Up Time', description: 'Vibrates at 9:59 every weekday.', startingBid: 79 },
    { title: 'Conference Lanyard Collection, 40 Pieces', description: 'Every badge from a decade of networking.', startingBid: 35 },
    { title: 'Slippers with Arrow Key Soles', description: 'Leave a trail of up, up, down, down.', startingBid: 23 },
    { title: 'Reflective Vest for Late Deploys', description: 'Stay visible during the 5 pm push.', startingBid: 18 },
    { title: 'Bow Tie, Clip-On, Tab-Indented', description: 'Formal wear that respects your linter.', startingBid: 15 },
    { title: 'Sneakers, Very Fast, Untested', description: 'Ship first, tie laces later.', startingBid: 130 },
    { title: 'Beanie with Propeller, Production Grade', description: 'Rated for 3,000 rpm in light wind.', startingBid: 25 },
  ],
  music: [
    { title: 'Vinyl: Greatest Dial Tones, Vol. 2', description: 'Remastered busy signals on 180 g vinyl.', startingBid: 32 },
    { title: 'Kazoo Ensemble Starter Kit', description: 'Twelve kazoos and a conductor baton.', startingBid: 20 },
    { title: 'Synthesizer That Only Plays Error Beeps', description: 'Four octaves of system notification sounds.', startingBid: 210 },
    { title: 'Electric Ukulele, Surprisingly Loud', description: 'Small instrument, large personality.', startingBid: 145 },
    { title: 'Cassette Mixtape: Songs to Debug To', description: 'Side B is just rain sounds and sighs.', startingBid: 11 },
    { title: 'Studio Headphones, One Side Louder', description: 'Perfect for listening with one ear on Slack.', startingBid: 65 },
    { title: 'Metronome Set to Release Cadence', description: 'Ticks every two weeks. Very relaxing.', startingBid: 26 },
    { title: 'Drum Machine with Snooze Button', description: 'Pauses the beat for nine more minutes.', startingBid: 175 },
    { title: 'Tuning Fork, Tuned to Fan Noise', description: 'Resonates with every server room.', startingBid: 13 },
    { title: 'Jukebox Loaded with Hold Music', description: 'Your call is important to this jukebox.', startingBid: 680 },
  ],
  outdoors: [
    { title: 'Tent That Sets Itself Up, Eventually', description: 'Read the README before camping.', startingBid: 160 },
    { title: 'Hammock Rated for One Long Weekend', description: 'Load-tested with a novel and a nap.', startingBid: 58 },
    { title: 'Compass That Points to the Nearest Wi-Fi', description: 'North is relative. Signal is absolute.', startingBid: 37 },
    { title: 'Camping Stove with Status Lights', description: 'Green means dinner. Red means read the logs.', startingBid: 72 },
    { title: 'Kayak, Lightly Used, Very Dry', description: 'Never left the garage. Excellent condition.', startingBid: 420 },
    { title: 'Bird Feeder with Rate Limiting', description: 'Ten seeds per bird per minute.', startingBid: 29 },
    { title: 'Trail Map of Our Old Monolith', description: 'Hand-drawn. Here be dragons.', startingBid: 24 },
    { title: 'Solar Charger for Optimists', description: 'Charges fully on the third sunny day.', startingBid: 46 },
    { title: 'Picnic Blanket, Waterproof Mostly', description: 'Keeps ants and most spills out.', startingBid: 31 },
    { title: 'Mountain Bike with Seventeen Gears', description: 'Uses two of them. The other fifteen are for show.', startingBid: 390 },
  ],
};
