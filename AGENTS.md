# AI Work Rules — Read Before Starting

You are working on a **production system**. Follow these rules strictly.

---

## 1. The Planning Protocol

### Pre-Planning Rules (Think Before Coding)
1. **Define assumptions** about requirements clearly before acting.
2. **If ambiguous, stop and ask.** Do not silently choose a path.
3. **Simplicity First** — propose the simplest solution. Reject unnecessary complexity.

### Protocol 1: Time Awareness
- Determine current date via shell. Search for latest stable releases up to that date.
- Document releases. Completely avoid deprecated versions.

### Protocol 2: Logical Flow & Feature Creep Prevention
- Stick only to required scope. No extra features, no unnecessary flexibility.
- Design user journey or data flow as achievable goals.

### Protocol 3: Smart Architecture (Simplicity First)
- Least amount of code that solves the problem.
- Create shared/core layer only for truly recurring logic. Don't abstract one-time code.
- Domain-driven partitioning. No micro-file fragmentation.

### Protocol 4: Safe Logging
- Simple, non-blocking (async) logging. Basic levels only. No performance impact.

### Protocol 5: External Memory
- Read PROJECT_MAP.md and AGENTS.md before making changes.
- Update PROJECT_MAP.md [ORPHANS & PENDING] section after each change.
- Maintain a Milestones-based Action Plan with verifiable goals.

---

## 2. The Execution Engine

### Protocol 1: Production-Ready Code
- **No placeholders or TODOs.** Code must be complete, error-handled, and logged.

### Protocol 2: Loop Until Verified
- Write tests or simulate flow for each segment.
- Clean up orphan code you created. Ensure no regression of existing features.

### Protocol 3: State Sync
- Dynamically update PROJECT_MAP.md after each change.
- Unbound features appear in [ORPHANS & PENDING] immediately. Delete upon completion.

### Protocol 4: Flow Adherence
- Always refer to [SYSTEM_FLOW] in PROJECT_MAP.md.
- Each line of code serves only the required user journey.

**Execution cadence:** (1. Execute → 2. Verify → 3. Update Map). Do not stop until [ORPHANS & PENDING] is empty.

---

## 3. Surgical Editing Protocol

### Rules for Surgical Changes
- **Only touch what needs touching.** Do not reformat adjacent code, rewrite comments, or refactor unless instructed.
- **Style match strictly.** Follow existing code style even if imperfect.
- **Only clean up your leftovers.** If your change creates orphan functions/imports, remove them. Do not touch old dead code.

### Protocol 1: Impact Analysis
- Read PROJECT_MAP.md. Identify affected files precisely.

### Protocol 2: Architectural Integrity
- DRY — no code duplication. Use shared/core layer. Add logging for new modifications.

### Protocol 3: Verification (Goal-Driven)
- Turn each modification into a verifiable goal. Test fails first, then make it succeed.
- Ensure legacy feature tests pass (No Regression).

### Protocol 4: State Sync
- Update PROJECT_MAP.md immediately. Deprecated code from your change must be remedied or logged.

---

## 4. Git & Deployment Workflow

### Branch Strategy
- **Production**: `master` — STABLE. Never edit directly.
- **Development**: `dev` branch on GitHub. All changes go through dev first.

### Dev → Prod Flow
1. `git checkout dev && git pull origin dev` — get latest dev
2. Make changes, test, verify
3. `git add . && git commit -m "description" && git push origin dev`
4. `git checkout master && git merge dev && git push origin master`
5. On server: pull, install, restart

### Deploy Commands
```bash
cd /var/www/unified-checkout && bash deploy.sh
# or all engines:
bash /var/www/deploy-all.sh
```

### Rollback
```bash
git log --oneline -5
git checkout <previous-stable-commit>
npm install && pm2 restart payment-engine
```

---

# Unified Checkout — Payment Engine

**Domain**: https://pay.dalletek.live  
**Port**: 3004 (PM2: `payment-engine`)  
**Repo**: `SaadEsadaf/unified-checkout.git`  
**Owner**: babilon26@gmail.com

## Tech Stack
- **Runtime**: Node.js v22
- **Backend**: Express.js, port 3004
- **Database**: SQLite via better-sqlite3 (`payments.db`)
- **Process Manager**: PM2

## System Flow
```
Payment Engine
  ├── /api/methods/enabled — List enabled payment methods
  ├── /api/checkout — Process payments
  ├── /admin — Admin panel
  └── Services: Stripe, PayPal, Sellup, Crypto, SEPA
```

## Supported Payment Methods
- Stripe
- PayPal
- Sellup (credit/points)
- Crypto (USDT, BTC)
- SEPA
- Email-link
- Credits, Points (internal)

## Dependencies
- **Business Engine**: https://dalletek.live
