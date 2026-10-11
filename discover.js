// discover.js — find a tailnet service by name through DNS-SD.
//
// A farm asks for "qwen" rather than carrying a URL. The answer lives in DNS
// (dns.private.fish/view/dns-service-discovery):
//
//   qwen._ollama._tcp.names.private.fish  SRV 0 0 443 ollama.mini.private.fish.
//   qwen._ollama._tcp.names.private.fish  TXT txtvers=1 model=qwen3:4b proto=https …
//
// A spec is a plain URL (used as is) or dnssd:<instance>.<_svc>.<_proto>.<zone>.
// Lookups go over DoH with NUMERIC record types — our endpoint answers a
// mnemonic (type=SRV) with an empty list, silently. A good answer is held for
// its TTL; when DNS fails, the last good answer serves, then the fallback.
// The Python twin is ~/drop/discover.py on the Pi5.
//
// Moved here from wiki-plugin-audionote/api/discover.js (Plan Tool Plan,
// Phase 4): the door's askOllama resolves its Ollama spec through it.

const doh = () => process.env.DNSSD_DOH || 'https://doh.names.private.fish/dns-query'
const SRV = 33
const TXT = 16
const DEFAULT_PORT = { https: 443, http: 80 }

const memo = new Map() // name -> { answer, expires }
const lastGood = new Map() // name -> answer, for the life of the process

const query = async (name, type) => {
  const res = await fetch(`${doh()}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`DoH answered ${res.status}`)
  const body = await res.json()
  return (body.Answer || []).filter(a => a.type === type)
}

// dns.google quotes each TXT string; our doh-proxy sends them bare and space-separated.
export const txtFields = answers => {
  const fields = {}
  for (const a of answers) {
    const quoted = [...String(a.data).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
    for (const s of quoted.length ? quoted : String(a.data).split(/\s+/).filter(Boolean)) {
      const i = s.indexOf('=')
      fields[i === -1 ? s : s.slice(0, i)] = i === -1 ? '' : s.slice(i + 1)
    }
  }
  return fields
}

export const parse = spec => {
  const labels = spec.slice('dnssd:'.length).split('.')
  if (labels.length < 4 || !labels[1].startsWith('_') || !labels[2].startsWith('_')) throw new Error(`not a dnssd spec: ${spec}`)
  return { name: labels.join('.') }
}

export const lookup = async name => {
  const hit = memo.get(name)
  if (hit && hit.expires > Date.now()) return hit.answer
  const srv = await query(name, SRV)
  if (!srv.length) throw new Error(`no SRV record for ${name}`)
  const best = srv.reduce((a, b) => (+b.data.split(' ')[0] < +a.data.split(' ')[0] ? b : a)) // lowest priority wins
  const [, , port, target] = best.data.split(/\s+/)
  const txt = txtFields(await query(name, TXT))
  const proto = txt.proto || 'https'
  const host = target.replace(/\.$/, '')
  const url = `${proto}://${host}${DEFAULT_PORT[proto] === +port ? '' : `:${port}`}`
  const answer = { url, target: host, port: +port, txt, ttl: best.TTL }
  memo.set(name, { answer, expires: Date.now() + best.TTL * 1000 })
  lastGood.set(name, answer)
  return answer
}

/** A spec to a base URL: live DNS, else the last good answer, else `fallback`. */
export const resolve = async (spec, fallback) => {
  if (!String(spec).startsWith('dnssd:')) return String(spec).replace(/\/+$/, '')
  const { name } = parse(spec)
  try {
    return (await lookup(name)).url
  } catch (e) {
    if (lastGood.has(name)) return lastGood.get(name).url
    if (fallback) return fallback.replace(/\/+$/, '')
    throw e
  }
}

