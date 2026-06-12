# Vægt Tracker

A local-first PWA for tracking body weight and nutrition — built for serious training.

- **Daily weight logging** with rolling 7-day average and weekly rate (kg/week, via linear regression)
- **Goal weight** with progress bar and ETA projection
- **BMI** with category and scale
- **Diet strategy** (cut / maintain / gain) + adjustable target rate
- **Eating guidance** that ties nutrition to your weight trend ("eat ~250 kcal more ≈ 190 g rice")
- **Meals & macros** — named meals, foods with kcal/protein/fat/carbs, daily totals
- **Saved dishes** and a **food library** for one-tap re-adding
- **CSV export/import**, daily reminder, fully offline

All data is stored locally in the browser (localStorage). No backend, no account.

## Run locally
```
python -m http.server 5189
```
Then open http://localhost:5189

Built with vanilla HTML/CSS/JS — no dependencies.
