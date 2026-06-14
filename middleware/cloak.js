const fs = require('fs')
const path = require('path')

const SAFE_PATHS = [
  '/api/checkout/webhook',
  '/api/checkout/return',
  '/api/checkout/settings',
  '/api/checkout/create',
  '/api/checkout/failover',
  '/payment/',
]

function ipInCIDR(ip, cidr) {
  const [rangeIp, bits] = cidr.split('/')
  const mask = ~(2 ** (32 - parseInt(bits)) - 1)
  const ipNum = ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0
  const rangeNum = rangeIp.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0
  return (ipNum & mask) === (rangeNum & mask)
}

function uaMatches(ua, patterns) {
  const lower = ua.toLowerCase()
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i')
      if (regex.test(ua)) return true
    } else {
      if (lower.includes(pattern.toLowerCase())) return true
    }
  }
  return false
}

function generateSafePage(config) {
  const { safe_page } = config
  const features = (safe_page.features || []).map(f =>
    `<div style="background:#1a1a2e;border:1px solid #16213e;padding:20px;border-radius:8px"><h3>${f.title}</h3><p style="color:#aaa;font-size:14px;margin-top:8px">${f.description}</p></div>`
  ).join('')

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${safe_page.title}</title><style>body{margin:0;font-family:Arial,sans-serif;background:#0f0f23;color:#fff}header{background:#1a1a2e;padding:20px;text-align:center}h1{font-size:36px;margin:0;color:#e94560}.hero{text-align:center;padding:80px 20px 40px}.hero h2{font-size:28px;margin:0}.hero p{color:#aaa;font-size:16px;max-width:600px;margin:16px auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;padding:0 40px 60px;max-width:1200px;margin:0 auto}footer{text-align:center;padding:30px;color:#555;font-size:13px}</style></head><body><header><h1>${safe_page.heading}</h1></header><div class="hero"><h2>${safe_page.subheading}</h2><p>${safe_page.description}</p></div><div class="grid">${features}</div><footer><p>Contact: ${safe_page.email}</p></footer></body></html>`
}

function generateHostingPage(config) {
  const { hosting_page } = config
  const plans = (hosting_page.plans || []).map(p =>
    `<div style="background:#1a1a2e;border:1px solid #16213e;padding:20px;border-radius:8px;text-align:center"><h3>${p.name}</h3><div style="font-size:24px;color:#e94560;margin:12px 0">${p.price}</div><ul style="list-style:none;padding:0;color:#aaa;font-size:13px">${p.features.map(f => `<li style="padding:4px 0">✓ ${f}</li>`).join('')}</ul></div>`
  ).join('')

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${hosting_page.title}</title><style>body{margin:0;font-family:Arial,sans-serif;background:#0f0f23;color:#fff}header{background:#1a1a2e;padding:20px;text-align:center}h1{font-size:28px;margin:0;color:#e94560}.hero{text-align:center;padding:60px 20px 30px}.hero h2{font-size:24px;margin:0}.hero p{color:#aaa;font-size:15px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px;padding:0 40px 60px;max-width:900px;margin:0 auto}footer{text-align:center;padding:20px;color:#555;font-size:13px}</style></head><body><header><h1>${hosting_page.heading}</h1></header><div class="hero"><h2>${hosting_page.subheading}</h2><p>Premium web hosting solutions for businesses worldwide.</p></div><div class="grid">${plans}</div><footer><p>${hosting_page.contact}</p></footer></body></html>`
}

function createCloakMiddleware(configPath) {
  let config
  let lastMtime = 0

  function loadConfig() {
    try {
      const stat = fs.statSync(configPath)
      if (stat.mtimeMs <= lastMtime && config) return config
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      lastMtime = stat.mtimeMs
    } catch {
      config = config || { platforms: [], safe_page: {}, hosting_page: {} }
    }
    return config
  }

  return function cloakMiddleware(req, res, next) {
    const cfg = loadConfig()
    const pathname = req.originalUrl || req.url

    if (SAFE_PATHS.some(p => pathname.startsWith(p))) {
      req.isRealUser = true
      return next()
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || ''
    const ua = req.headers['user-agent'] || ''

    if (!ip && !ua) {
      req.isRealUser = true
      return next()
    }

    for (const platform of cfg.platforms) {
      if (!platform.ips && !platform.uas) continue

      let matched = false
      if (platform.ips && ip) {
        for (const cidr of platform.ips) {
          if (ipInCIDR(ip, cidr)) { matched = true; break }
        }
      }
      if (!matched && platform.uas && ua) {
        matched = uaMatches(ua, platform.uas)
      }

      if (matched) {
        res.setHeader('X-Cloak', platform.name)

        if (platform.page === 'hosting') {
          return res.send(generateHostingPage(cfg))
        }
        return res.send(generateSafePage(cfg))
      }
    }

    req.isRealUser = true
    next()
  }
}

module.exports = { createCloakMiddleware }
