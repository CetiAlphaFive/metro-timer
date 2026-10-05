// Pure commute logic: no DOM, no network. Shared by app.js and tests/.

export const ST = {
  VAN_NESS: 'A06',
  FARRAGUT_NORTH: 'A02',
  FARRAGUT_WEST: 'C03',
  VIRGINIA_SQ: 'K03',
};

export const LINE_NAMES = { RD: 'Red', OR: 'Orange', SV: 'Silver', BL: 'Blue', YL: 'Yellow', GR: 'Green' };

// Scheduled ride times in minutes. Replaced by WMATA's RailTime once fetched.
export const DEFAULT_RIDES = { 'A06-A02': 9, 'C03-K03': 11, 'K03-C03': 11, 'A02-A06': 9 };

// Rough gaps between trains, used only when the live board doesn't reach far enough.
export const HEADWAY = { red: 6, orsv: 5 };

export const DEFAULT_SETTINGS = {
  apiKey: '',
  homeWalk: 10,   // door -> Van Ness platform
  officeWalk: 4,  // Mercatus -> Virginia Square platform (and back)
  cushion: 2,     // minutes to spare on the platform
  crossWalk: 4,   // Farragut North <-> Farragut West platform to platform
};

const isRed = t => t.line === 'RD';
const isOrSv = t => t.line === 'OR' || t.line === 'SV';

// Direction comes from the API's track Group. At A06, A02, C03 and K03, Group "1" runs toward
// Glenmont / New Carrollton / Largo and "2" toward Shady Grove / Vienna / Ashburn (checked against
// live data). DestinationCode can't be used: WMATA leaves it null for many trains.
export const FILTERS = {
  // Toward Glenmont (Van Ness and Farragut North, morning)
  redSouth: t => isRed(t) && t.group === '1',
  // Toward Shady Grove (Farragut North, evening)
  redNorth: t => isRed(t) && t.group === '2',
  // Toward Vienna / Ashburn through Virginia Square (Farragut West, morning)
  orsvWest: t => isOrSv(t) && t.group === '2',
  // Toward downtown (Virginia Square and Farragut West, evening)
  orsvEast: t => isOrSv(t) && t.group === '1',
};

// Normalize the raw GetPrediction payload. "ARR"/"BRD" become 0; blanks and "---" are dropped.
export function parseTrains(raw) {
  const out = [];
  for (const t of raw?.Trains || []) {
    let min;
    if (t.Min === 'ARR' || t.Min === 'BRD') min = 0;
    else if (/^\d+$/.test(String(t.Min ?? '').trim())) min = Number(t.Min);
    else continue;
    if (!LINE_NAMES[t.Line] || /no passenger/i.test(t.DestinationName || '')) continue;
    out.push({
      station: t.LocationCode,
      line: t.Line,
      group: String(t.Group ?? ''),
      destCode: t.DestinationCode || '',
      dest: t.DestinationName || t.Destination || '',
      cars: t.Car || '',
      min,
    });
  }
  return out;
}

// Trains at one station matching a filter, with minutes-away adjusted for data age, soonest first.
export function board(trains, station, filter, elapsedMin) {
  return trains
    .filter(t => t.station === station && filter(t))
    .map(t => ({ ...t, away: t.min - elapsedMin }))
    .filter(t => t.away > -1)
    .sort((a, b) => a.away - b.away);
}

// For each train at the origin: how long until you must leave, and whether it's catchable.
//   ok    -> leave in >= 0 min with the full cushion
//   hurry -> catchable only by eating into the cushion
//   gone  -> can't make it
export function departures(originBoard, walk, cushion) {
  return originBoard.map(t => {
    const leaveIn = t.away - walk - cushion;
    const status = leaveIn >= 0 ? 'ok' : leaveIn >= -cushion ? 'hurry' : 'gone';
    return { train: t, leaveIn, status };
  });
}

// Given when you'll be standing on the transfer platform (minutes from now), find the train you catch.
// Returns { train, wait, rating, hustle } when the live board covers it, else { estimate: true, wait }.
// hustle is a train leaving up to 2 min before you'd arrive: catchable if you move fast.
export function connect(readyIn, transferBoard, headway) {
  const next = transferBoard.find(t => t.away >= readyIn);
  if (!next) return { estimate: true, wait: headway / 2, headway };
  const wait = next.away - readyIn;
  const hustle = transferBoard.filter(t => t.away < readyIn && t.away >= readyIn - 2).pop() || null;
  return { train: next, wait, rating: wait < 2 ? 'tight' : 'comfortable', hustle };
}

// Morning before 1pm, evening after.
export function defaultDirection(date) {
  return date.getHours() < 13 ? 'am' : 'pm';
}

// Everything the screen needs for one direction, computed from parsed trains.
export function plan(dir, trains, settings, rides, elapsedMin) {
  const s = settings;
  if (dir === 'am') {
    const origin = board(trains, ST.VAN_NESS, FILTERS.redSouth, elapsedMin);
    const xferFrom = board(trains, ST.FARRAGUT_NORTH, FILTERS.redSouth, elapsedMin);
    const xferTo = board(trains, ST.FARRAGUT_WEST, FILTERS.orsvWest, elapsedMin);
    return build({
      origin, xferFrom, xferTo,
      walk: s.homeWalk, endWalk: s.officeWalk,
      ride1: rides['A06-A02'], ride2: rides['C03-K03'],
      headway2: HEADWAY.orsv,
    }, s);
  }
  const origin = board(trains, ST.VIRGINIA_SQ, FILTERS.orsvEast, elapsedMin);
  const xferFrom = board(trains, ST.FARRAGUT_WEST, FILTERS.orsvEast, elapsedMin);
  const xferTo = board(trains, ST.FARRAGUT_NORTH, FILTERS.redNorth, elapsedMin);
  return build({
    origin, xferFrom, xferTo,
    walk: s.officeWalk, endWalk: s.homeWalk,
    ride1: rides['K03-C03'], ride2: rides['A02-A06'],
    headway2: HEADWAY.red,
  }, s);
}

function build(p, s) {
  const deps = departures(p.origin, p.walk, s.cushion).map(d => {
    const readyIn = d.train.away + p.ride1 + s.crossWalk;
    const conn = connect(readyIn, p.xferTo, p.headway2);
    const departIn = conn.estimate ? readyIn + conn.wait : conn.train.away;
    return { ...d, readyIn, conn, arriveIn: departIn + p.ride2 + p.endWalk };
  });
  const hero = deps.find(d => d.status === 'ok') || null;
  const hurry = deps.filter(d => d.status === 'hurry').pop() || null;
  const crossing = p.xferFrom.slice(0, 4).map(t => {
    const readyIn = t.away + s.crossWalk;
    return { train: t, readyIn, conn: connect(readyIn, p.xferTo, p.headway2) };
  });
  return { deps, hero, hurry, crossing, transferBoard: p.xferTo };
}
