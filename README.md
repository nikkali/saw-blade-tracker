# Saw Blade Production Tracker

A small web app that follows every saw blade from order to delivery and keeps one serial
register that can never issue the same number twice. It was built for 24 inch, 72 tooth
forestry blades. It runs today at https://helanbak-blades.netlify.app.

This copy is public so you can rebuild it or change it for your own shop. The customers, costs
and names in `lib/seed.mjs` are made-up samples. Your real records are not in this repository.

## If you are a Claude helping with this

Start here, in this order:

1. `lib/config.mjs` holds the shop route (the list of steps). Changing the process means changing that list.
2. `lib/core.mjs` is the whole backend: orders, steps, serial numbers, voids, scrap, rework, stock.
3. `test/core.test.mjs` has 79 tests. Run `npm test` before and after every change.
4. `public/` is the front end (plain HTML and JavaScript, no framework).
5. `netlify/functions/api.mjs` connects the backend to Netlify Functions and Netlify Blobs storage.

## Run it on your computer

```bash
npm install
npm test
node dev-server.mjs        # http://localhost:4177, passcodes office-dev and floor-dev
BLADE_DEMO=1 node dev-server.mjs   # fake records, open to the Wi-Fi for tablet testing
```

Never serve real records to the Wi-Fi.

## Put it on Netlify

1. Make a Netlify site.
2. Set these environment variables on the site: `BLADE_OFFICE_PASSCODE`, `BLADE_FLOOR_PASSCODE`
   (pick your own), and `BLADE_STORE` (a storage name, for example `blade-tracker-v1`).
3. Deploy: `npx netlify-cli deploy --prod --no-build --dir public --functions netlify/functions --site <your site id>`

## How it works

- A blade exists from the order, before it has a serial. It shows as "Order N blade" until the laser step.
- The serial is claimed with a create-only write, so two tablets cannot get the same number.
  A number is never reused: void and scrap stay in the register.
- Two passcodes. Floor: no money and no customer details (the server enforces this). Office: everything.
- "Lasered" sends the number on the operator's screen. The server refuses it if the blade no longer holds that number.
- `lib/store-blobs.mjs` treats a write with no returned etag as unproven and reads it back.
- A stock build is an order of kind `stock`. A stock blade cannot ship until it is assigned to a customer order.
