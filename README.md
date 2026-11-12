# Missing Due Dates

Lists Jobseeker App Delivery tickets (current sprint, In Preparation) with no due date and sets it in YouTrack.

- `.env`: `YOUTRACK_TOKEN`, `APP_USERNAME`, `APP_PASSWORD`
- `npm run dev` (or `npm run build && npm run preview`)
- API proxy lives in `vite.config.js`; the token never reaches the browser.
