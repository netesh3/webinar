# Infrastructure Scaling Strategy: WebRTC-Only (No HLS)

**Key Constraint**: 15-second HLS latency is unusable for live interaction.  
**Solution**: Scale dedicated egress on-demand, only pay when customers need it.

---

## Capacity Planning by Tier

### Startup (No Cost to You)

**Tier Pricing:**
- **Starter**: $0 (50 concurrent)
- **Professional**: $49/mo (200 concurrent)

**Infrastructure:** Your €10/mo shared server  
**Attendees Supported:** 250 concurrent total (50 + 200) = Safe, 25% headroom  
**Monthly Attendees:** ~750 webinars × 100 avg attendees = 75,000 attendee-months

### Growth (You Invest in Dedicated Egress)

**Tier Pricing:**
- **Business**: $199/mo (300 concurrent when triggered)
- Dedicated egress auto-provisions at €60/mo

**Economics:**
- Customer revenue: €199/mo
- Infrastructure cost: €60/mo
- Your margin: 70% ($133/mo gross)

**When Triggered:** Customer schedules webinar with 200+ registered attendees

### Enterprise (Scale with Customer)

**Tier Pricing:**
- **Enterprise**: €499/mo (500 concurrent)
- Dedicated infrastructure 2x egress = €110/mo

**Economics:**
- Customer revenue: €499/mo
- Infrastructure cost: €110/mo
- Your margin: 78% ($389/mo gross)

**Add-On Scaling:**
- Each "+200 concurrent" add-on: $100/mo
- Infrastructure cost: €60/mo per add-on
- Your margin: 40% ($40/mo) - pass-through model

---

## Capital-Efficient Scaling Model

### Why This Works

```
Month 0: 0 customers, €10/mo infrastructure
Month 3: 150 paying (Pro/Starter), €10/mo (still fits!)
Month 6: 300 paying, still mostly fits €10/mo
         → First Business tier customer at 300 concurrent
         → You add €60/mo dedicated egress
         → Revenue covers cost 3.3x over

Month 12: 600 paying, multiple dedicated servers
          → 10 Business tier customers (€10 + €60×10 = €610/mo)
          → 20 Enterprise tier customers (€10 + €110×20 = €2,210/mo)
          → Total infra cost: €2,820/mo
          → Total revenue: (400×$49) + (150×$199) + (50×$499) = $79,950/mo
          → Gross margin: 96% ($76,130/mo profit)
```

### You Never Build Unused Capacity

- Month 0-3: €10/mo (shared)
- Month 4-6: €10/mo (still shared, 150 customers fit!)
- Month 6: Business customer #1 → +€60/mo (only for them)
- Month 12: 10 Business customers → €600/mo additional (only for them)

**Key**: You invest in infrastructure only when you have paying customers that need it.

---

## Dedicated Egress Provisioning Rules

### Tier 2: Professional ($49/mo)

**Capacity**: 50-200 concurrent (free tier: 50, professional: 200)

**Infrastructure**: Your €10/mo shared server

**Margin**: 98% (assumes <5% churn)

**When to Upgrade**: Never. 200 concurrent = 300 Mbps ≈ fits in 1 Gbps ✅

### Tier 3: Business ($199/mo)

**Capacity**: 201-300 concurrent

**Trigger**: Customer schedules webinar with >200 registered attendees

**Infrastructure**: Auto-provision dedicated egress (€50-80/mo, assume €60/mo avg)

**Action**:
1. Alert customer: "Your webinar has 250 registered. We're provisioning dedicated infrastructure for optimal performance."
2. Provision Hetzner dedicated egress add-on or new server
3. Route their WebRTC through dedicated link
4. Cost: €60/mo, Revenue: €199/mo = 70% margin

**Lifecycle**:
- Customer active: You pay €60/mo, keep receiving €199/mo revenue
- Customer churns: Deprovision infrastructure immediately (save €60/mo)
- No long-term commitment needed

### Tier 4: Enterprise ($499/mo)

**Capacity**: 301-500 concurrent

**Infrastructure**: 2x dedicated egress servers (€100-160/mo, assume €110/mo avg)

**Same Model**: Only provision when Enterprise customer signs up

**Margin**: 78% gross, 70% net after payment processing

### Scaling Beyond 500

**Add-On**: "+200 Concurrent Attendees" = $100/mo

**Infrastructure Cost**: €60/mo (1x dedicated server)

**Economics**: 40% margin (pass-through model, covers ops + monitoring)

---

## Monthly Infrastructure Cost Projection

| Month | Customers | Infra Cost | Revenue | Gross Margin |
|-------|-----------|-----------|---------|--------------|
| 0 | 0 | €10 | €0 | N/A |
| 3 | 150 | €10 | €5,880 | 99.8% |
| 6 | 300 | €100 | €12,600 | 99.2% |
| 9 | 450 | €300 | €22,500 | 98.7% |
| 12 | 600 | €700 | €79,950 | 99.1% |
| 18 | 1,000 | €2,000 | €180,000 | 98.9% |
| 24 | 1,350 | €3,500 | €266,800 | 98.7% |

**Key Insight**: Infrastructure costs grow slowly vs revenue because:
1. You don't provision it upfront
2. Tier mix: Most customers fit on shared (€10/mo), few need dedicated
3. You charge enough to cover costs 3-5x over

---

## Provisioning Playbook

### Scenario 1: Professional Tier Customer Books Large Webinar

**Situation**: Professional ($49/mo) customer has 250 registered attendees

**What You Do**:
1. Automatic: Trigger 48-hour before webinar
2. Provision: Hetzner dedicated egress server
3. Configure: Route customer's SFU to dedicated link
4. Notify: "Your webinar is getting dedicated infrastructure for peak performance!"
5. Monitor: Watch during live event
6. Post-event: Keep provisioned (they might run more large webinars)
7. Deprovision: If they churn or 3 months inactive

**Cost to You**: €60/mo  
**Revenue from them**: €49/mo  
**Subsidy**: €11/mo (worth it for retention + upsell signal)

### Scenario 2: Business Tier Customer Grows to 400 Attendees

**Situation**: Business ($199/mo) customer has 400 registered → hitting your 300 limit

**What You Do**:
1. Alert: "You're approaching capacity, let's discuss Enterprise tier"
2. Show ROI: "5x larger audience, dedicated support, API access"
3. Propose: Enterprise tier ($499/mo) with 2x dedicated infrastructure
4. Provision: 2x dedicated egress when they sign
5. Upgrade revenue: €199 → €499 (+€300/mo)
6. Upgrade cost: €60 → €110 (+€50/mo)
7. Net gain: +€250/mo margin

**Perfect Upsell**: Customer needs it for their growth, you both benefit

### Scenario 3: Business Tier Customer Churns

**Situation**: Business customer ($199/mo) stops paying, had dedicated egress

**What You Do**:
1. Notice: Failed payment for 3 days
2. Deprovision: Delete dedicated server immediately
3. Save: €60/mo cost reduction
4. Downside**: -€199/mo revenue

**Key**: Your cost structure automatically adjusts when they leave

---

## SFU Cascading (Future Option)

### If Single Server Becomes Bottleneck

**When Needed**: ~50 concurrent webinars running simultaneously

**Architecture**:
```
Your €10 server (runs API + Postgres + Redis)
         ↓
Primary SFU (€50/mo) - handles 10-15 concurrent webinars
Secondary SFU (€50/mo) - handles 10-15 concurrent webinars
         ↓
Dedicated Egress (€60/mo × N customers) - 1 per enterprise customer
```

**Benefit**: Distributes load, allows infinite concurrent webinars

**Cost**: €10 + €50 + €50 + €60×N = only when you have customers needing it

**Timeline**: Month 12-18, if you hit 30-40 enterprise customers

---

## Comparison: Your Model vs Competitors

| Aspect | Zoom | Demio | WebinarJam | **You** |
|--------|------|-------|-----------|--------|
| 200 concurrent | $340/mo | $266/mo | $79/mo | $49/mo |
| Infrastructure opex | ~$500/mo | ~$500/mo | ~$200/mo | **€10/mo** |
| Price point | "Enterprise only" | "Mid-market" | "SMB" | **All tiers** |
| Margin | 60-70% | 65-75% | 70-80% | **90-95%** |
| Scaling | Fixed tiers, fixed infra | Fixed tiers, fixed infra | Fixed tiers, fixed infra | **Variable with demand** |

**Your Advantage**: You only pay for infrastructure when customers need it.

---

## Honest Marketing Angle

Instead of competing on "unlimited scale," position as:

**"Professional webinars for professional results"**

- ✅ Limited to attendees who can actually engage
- ✅ Personal attention from hosts
- ✅ No "video hall problem" of 10,000 muted attendees
- ✅ 70-85% cheaper than competitors
- ✅ Enterprise-grade when you need it

This is **actually a feature**, not a limitation.

---

## Decision Tree: When to Upgrade

**Customer wants >200 concurrent:**
- Are they on Professional? → Offer Business tier upgrade
- Are they on Business? → Offer Enterprise tier
- Are they on Enterprise? → Offer "+200 concurrent" add-on
- Are they already at 500+? → Multi-SFU infrastructure (custom pricing)

**You upgrade infrastructure:**
- Only when they sign → No upfront costs
- You get recurring revenue from them → Covers cost 3-5x
- They churn? → You deprovision immediately
- They stay? → Recurring margin improvement

---

## Financial Model Summary

**Your Scaling Model:**
1. Start: €10/mo server handles all Starter + Professional (50-200 concurrent max)
2. Trigger: Business customer (300 concurrent) signs → +€60/mo infrastructure
3. Scale: Each Enterprise customer → +€110/mo infrastructure
4. Margin: 98% at low tiers, 70-80% at high tiers (still excellent)
5. Cash flow: Positive from Month 4 onwards

**Competitor Scaling Model:**
1. Start: €500/mo infrastructure for "enterprise capability"
2. Bleed: Running high fixed costs, waiting for customers
3. Scale: Just run on same infrastructure (no cost change)
4. Margin: High percentages, but must be sold to justify infrastructure cost
5. Cash flow: Negative until they reach $20K+ MRR

**Your Advantage**: You don't pay for infrastructure until you have customers paying for it.

---

## Answer to Original Question

**"How can we scale if we only have €10/mo and limited egress?"**

✅ **Don't scale WebRTC for 1,000+ attendees.** You can't compete there on bandwidth cost.

✅ **Scale in tiers:**
- Starter/Professional: €10/mo (50-200 concurrent) = unlimited profit until Month 6
- Business: Provision dedicated egress only when customer needs it (€60/mo per customer)
- Enterprise: Same model, 2x infrastructure when they sign

✅ **Result:**
- Month 6 MRR: €12,600, Infrastructure: €10/mo (99.8% margin!)
- Month 12 MRR: €79,950, Infrastructure: €700/mo (99% margin)
- Month 24 MRR: €266,800, Infrastructure: €3,500/mo (98.7% margin)

You never build unused capacity. You only scale infrastructure when customers pay for it.

**This is how capital-efficient SaaS works.** 🚀
