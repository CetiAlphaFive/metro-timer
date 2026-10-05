# Metro Timer

Phone web app for the Van Ness ⇄ Virginia Square-GMU commute via the Farragut crossing.
Shows when to leave (walk + spare time before the train), which Orange/Silver (or Red) train
you'll connect to after the walk between Farragut North and Farragut West, and a live board for the transfer station.

- Live data: WMATA `GetPrediction` for A06, A02, C03, K03 in one call, every 30 s while open.
- Ride times: WMATA scheduled `RailTime`, cached for a week.
- Your API key is entered in Settings and stored only in the browser's localStorage. It is not in this repo.

## Use
Open the GitHub Pages URL in Chrome on Android → ⋮ → **Add to Home screen**.
Tune your walk times and spare minutes in ⚙.

## Develop
No build step. Serve the folder (`python3 -m http.server`) and open it.
Tests: `node --test tests/`
