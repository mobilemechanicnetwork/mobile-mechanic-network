# Mobile Mechanic Network — website (real hosting build)

One website for everything: the public site plus accounts for vehicle owners
and mobile mechanics. This codebase is portable — it runs on any host that
runs Node.js, and the domain (mobilemechanicsinmyarea.com) points at it once
deployed. The Muse artifacts (landing page + MVP app) remain the design
reference and feature spec; this is the production build.

## Run locally
    node server.js        # http://localhost:3000  (PORT env var overrides)

No dependencies. Node 18+.

## Stages
1. [done] Public home page (the approved landing page) + account system:
   register / log in / log out, roles (vehicle owner, mobile mechanic),
   scrypt-hashed passwords, session cookies, per-role dashboard stub.
   Accounts stored in data/users.json at this stage.
2. [done, basic] Mechanic business pages (city/state + services, publish
   toggle) and a public directory/search at /mechanics. Still to port from
   the MVP spec: photos, social links, reviews/badges, fixed-price menus,
   map/radius service areas.
3. [done, basic] Quote requests at /request: owner describes the job once;
   published mechanics in the same state who offer that service see it in
   their dashboard inbox and quote; the owner accepts/declines from their
   dashboard. Verified end to end locally 2026-10-20. Still to port:
   one-to-one requests from a business page, text/email notifications
   (Twilio stage), secure token links for non-account replies, emergency
   "Need help now" flow, vehicle/address privacy rules in the UI.
4. Deploy (full checklist, verified complete 2026-10-20):
   Brandon: (a) create free GitHub account (account #1 was made via Google
   SSO on 2026-10-20 — the browser's saved password login was rejected
   because SSO accounts have no GitHub password, then Google put its
   "verify it's you" wall in front of the browser; Brandon then started a
   second account with email+password but GitHub showed "access is
   temporarily restricted" — an anti-abuse rate limit likely tripped by the
   earlier failed login automation; advised to wait and retry from a
   different connection); (b) create Railway account +
   payment method (Hobby ~$5/mo, always-on); (c) upload the prepared code
   bundle (~/workspace/mmn-website-upload.zip) to a new GitHub repo
   (click-by-click steps from Bodhi); (d) enter the DNS records Railway
   shows into Porkbun for mobilemechanicsinmyarea.com (root + www, exact
   entries from Bodhi); (e) later: Stripe, Twilio, Maps-key accounts.
   Bodhi: (f) code prepped for hosting (package.json start script,
   DATA_DIR env storage setting — both done and smoke-tested 2026-10-20);
   (g) create the Railway project from the repo, attach a storage volume,
   set DATA_DIR to the volume; (h) add the custom domain in Railway;
   (i) verify live over HTTPS on the real domain: home page, test owner +
   mechanic accounts, business publish, quote request in a served city,
   quote, accept — then delete test data.
   Notes: SSL is automatic after DNS propagates (minutes to a few hours).
   JSON file storage on the volume is the launch setup; a managed
   Postgres database is a later upgrade, not a launch blocker.
   Post-launch business steps: domain email (free Porkbun forwarding) so
   the Terms carry a real legal contact + attorney review; LLC + Slidell
   occupational license before the first subscription money moves;
   optional: buy the singular domain spelling (~$11) and point it here.
   Not yet built for the website (post-launch ports): founder admin view,
   photos/reviews/badges, one-to-one requests, emergency flow.
5. Integrations (Brandon's accounts, entered in an admin settings screen,
   never in chat): Stripe subscriptions (90-day trial, $24.99/mo, $200/yr),
   Twilio texting, Google Maps key (restricted), AI assistant key.

## Deploy-time accounts Brandon creates
- Hosting account (Node host, free tier is fine to start)
- Database (managed Postgres free tier) — or decided at deploy
- Stripe, Twilio (already planned)

## Rules carried over from the MVP spec
- Vehicle owner / mobile mechanic terminology everywhere.
- No em dashes in customer-facing application/launch writing.
- Street address stays private until a quote is accepted.
- Fair Price Guide: mechanic's price is authoritative; guide ranges never
  shown beside a live quote.
- Terms & Conditions still need attorney review before real launch.
