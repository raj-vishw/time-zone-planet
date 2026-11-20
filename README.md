# Time-Zone Planet

A low-poly model of the real Earth, lit by the real sun. A ray of light rides the dawn line as it sweeps around the planet, and everyone on the site right now is a glowing dot, so you can watch the world wake up live.

- **Real sunlight.** The day/night line is computed from the current UTC time (solar declination plus the equation of time).
- **The real Earth, faceted.** 46,000 flat-shaded faces coloured from NASA Blue Marble satellite imagery, with mountains raised from NASA topography and ocean colour following real depth. Clouds drift in a faceted layer that follows the climate bands and turns gold at dawn.
- **Live visitors.** Each place with people on the site gets a dot that pulses, grows with the crowd and flares as dawn passes over it. Hover or tap a dot to see its local time.
- **Earlier visitors.** Places visited in the last 24 hours that nobody is at right now stay on the globe as faint dots. They still flare as dawn reaches them, so the globe never looks empty.
- **City lights.** Every town of 50,000+ people glows on the night side. The lights switch off one by one through twilight as dawn comes, and back on at dusk.
- **Replay.** Drag the time bar or press ▶ to replay the last 24 hours. The dawn line sweeps the globe while past visits light up hour by hour.
- **Follow the sun.** This button keeps the camera on the dawn line.
- **Sunrise now.** A list of places where the sun is coming up right now. Click one to fly there.

## Run it locally

```sh
node tools/dev-server.mjs      # http://localhost:8730, site plus API with an in-memory Redis
```

No install step and no dependencies are needed, only Node 18 or newer.

There's no geo data locally, so you're placed from your browser's time zone. The comment at the top of `tools/dev-server.mjs` shows how to add fake visitors with `curl`.

- `?demo` fills the globe with simulated visitors, clearly labelled **DEMO**. It works on any static server.
- With any plain static server (`python -m http.server`), the page runs in **offline** mode and shows only you.
- `?nobloom` turns off the glow pass. It's off on touch devices anyway.
- On a slow GPU the page lowers its resolution, then turns off the glow, until it runs smoothly. `?hq` keeps full quality (for screenshots).

## Tests

```sh
npm test                       # sun maths + API handlers against a fake Redis
npm install                    # only needed to rebuild the globe: installs the dev-only JPEG decoder
npm run build:globe            # rebuild globe/land.json (~1.5 min; downloads the source data once into tools/.cache)
```

## Deploy (Vercel)

1. Import the `time-zone-planet` folder as a new Vercel project. Framework preset: **Other**. No build command, and the output directory is the root.
2. Under **Storage**, add **Upstash for Redis** (free tier) and connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Redeploy. The pill in the top right should turn green and read "1 online".

The `og:image` tags are relative. Swap in the full URL once the domain is known.

## How it works

| Piece | Where |
|---|---|
| Sun position, local times | `src/sun.js` |
| Low-poly mesh, day/night/dawn shader, clouds, light curtain, city lights, atmosphere, hour ring | `src/globe.js` |
| Visitor dots (one instanced draw call, glow and flare on the GPU) | `src/dots.js` |
| Heartbeat, polling, offline fallback, demo | `src/net.js` |
| HUD | `src/hud.js`, `style.css` |
| `POST /api/beat`, `GET /api/live`, `GET /api/history` | `api/` |
| Land mask, face colours (256-colour palette), relief and city lights, precomputed | `tools/build-globe.mjs` → `globe/land.json` (~73 KB gzipped) |

The browser sends a heartbeat every 60 s and polls `/api/live` every 20 s. A repeat heartbeat is a single Redis command (`ZADD`); pruning happens in `/api/live`, which the CDN caches for 15 s, so Redis traffic stays flat however many people are watching. Heartbeats stop while the tab is hidden.

## Privacy

- Location comes from Vercel's request geo headers and is rounded to 0.5° (about 50 km).
- The IP address is never read or stored.
- The session id is random and lives only in `sessionStorage`.
- Presence expires after 2 minutes, and the hourly replay counts expire after 26 hours. The faint "earlier" dots are those same hourly counts.
- Responses group visitors by place and never include session ids.

## Credits

Land shapes and city lights come from [Natural Earth](https://www.naturalearthdata.com/) (public domain): 1:50m land via [world-atlas](https://github.com/topojson/world-atlas), and 1:10m populated places. Surface colours, heights and the water mask come from NASA's Blue Marble and topography images (public domain), using the copies in the [three-globe](https://github.com/vasturiano/three-globe) examples. Rendering uses [three.js](https://threejs.org/).
