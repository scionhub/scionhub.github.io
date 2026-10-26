# ScionBase — website (POC)

Static single-page site for **ScionBase**: git-like code hosting with repository content stored on
Filecoin via PDP (Proof of Data Possession), addressed by PieceCID and read directly from storage providers.

- `index.html` / `404.html` — identical SPA shell (404.html makes deep links work on GitHub Pages)
- `assets/js/app.js` — lit-html app: home, orgs, org, repo (tree/blob/PRs/sync), sign in, new repo, CLI guide
- `assets/js/config.js` — API base URL
- `checkout.html` — POC checkout (no real payment)

Run locally: `python3 -m http.server 8080` and open `http://localhost:8080/#/`.

Pricing (POC): $1/GB/year with a minimum of 1 GB (USD or ETH). Contact: https://filoz.org
