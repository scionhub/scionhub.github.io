# ScionHub — Static site (POC)

This repository contains a responsive, accessible, static marketing site for ScionHub:

- Hosted OpenScion on Cloudflare Workers + D1
- Verifiable storage on Filecoin via the PDP API (Synapse SDK), identified by PieceCID
- GitHub-like multi-tenant model (first org: `filecoin-project`)
- Proof of concept — claims are intentionally conservative

## Local development

No build step is required; serve the static files with any HTTP server.

Using Python 3:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

Entry points:
- `index.html` — landing page (benefits, architecture, pricing)
- `checkout.html` — POC checkout (no real payment)

## Pricing

- Free for the first 6 months or first 1 GB, whichever comes first
- Then $5/GB/month, payable in USD or ETH
- The provided checkout flow is a POC — no real payment is taken

If you are interested in pilots or production usage, contact FilOz:

- Website: https://filoz.org

## Deploying with GitHub Pages

This repo includes a minimal Pages workflow (`.github/workflows/pages.yml`) that publishes the static site.
Enable Pages on the repository and set the source to GitHub Actions.

## License

Unless otherwise noted, content in this repository is provided under the MIT License.
