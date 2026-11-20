// Checks sun.js against known solar events. Run: node tools/test-sun.mjs
import { subsolarPoint, sunAltitude, isMorning, localTime, zoneOffsetHours } from '../src/sun.js';
let fail = 0;
const near = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.toFixed(3)} (want ${want} ±${tol})`);
};
// March equinox 2024-03-20 03:06 UTC: declination ~0
near('equinox declination', subsolarPoint(Date.UTC(2024, 2, 20, 3, 6)).lat, 0, 0.05);
// June solstice 2024-06-20 20:51 UTC: declination ~ +23.44
near('june solstice declination', subsolarPoint(Date.UTC(2024, 5, 20, 20, 51)).lat, 23.44, 0.05);
// December solstice 2024-12-21 09:20 UTC: ~ -23.44
near('dec solstice declination', subsolarPoint(Date.UTC(2024, 11, 21, 9, 20)).lat, -23.44, 0.05);
// Equation of time early Nov is ~ +16.4 min, so solar noon at Greenwich is ~11:43:36 UTC on 2024-11-03.
near('solar noon lon (EoT)', subsolarPoint(Date.UTC(2024, 10, 3, 11, 43, 36)).lon, 0, 0.3);
// Mid Feb EoT ~ -14.2 min: solar noon at Greenwich ~12:14:12 UTC on 2024-02-11
near('solar noon lon (EoT Feb)', subsolarPoint(Date.UTC(2024, 1, 11, 12, 14, 12)).lon, 0, 0.3);
// Sunrise in London 2024-06-21 is 03:43 UTC (geometric centre ~ -0.83° incl. refraction)
near('London sunrise altitude', sunAltitude(51.5, -0.13, Date.UTC(2024, 5, 21, 3, 43)), -0.83, 0.4);
console.log(isMorning(51.5, -0.13, Date.UTC(2024, 5, 21, 3, 43)) ? 'ok   London 03:43 UTC is morning' : (fail++, 'FAIL morning'));
console.log(!isMorning(51.5, -0.13, Date.UTC(2024, 5, 21, 20, 0)) ? 'ok   London 20:00 UTC is evening' : (fail++, 'FAIL evening'));
console.log(localTime(Date.UTC(2024, 0, 1, 0, 0), 'Asia/Kolkata'), 'Kolkata at 00:00 UTC (want 05:30)', zoneOffsetHours(Date.UTC(2024, 0, 1), 'Asia/Kolkata'));
console.log(localTime(Date.UTC(2024, 0, 1, 0, 0), 'Bogus/Zone', 90), 'bad zone at 90E (want 06:00)');
process.exit(fail ? 1 : 0);
