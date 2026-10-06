// All keys are supplied through KEYS so RedisNamespace can prefix every access.
// ARGV[1] is the platform's TTL; ARGV[2] is the operation payload. Redis TTL is GC only.
// Session JSON string: msg:<client_msg_id> -> run_id, run:<run_id> -> encoded ticket + settlement,
// last -> run_id, rounds -> lifetime accepted rounds. One expiring snapshot keeps acceptance
// and settlement together. Unlike HGETALL's unordered fields, GET preserves the exact bytes
// across read-only rejections, duplicates and repeated settlements. Only successful writes
// serialize the snapshot; reading it never refreshes its TTL.
const COMMON = `
local ttl = tonumber(ARGV[1])
local p = cjson.decode(ARGV[2])
local function loadSession()
  -- Preserve tickets from the previous hash layout; replace it only when a write is due.
  if redis.call('TYPE', KEYS[1]).ok == 'hash' then
    local fields = redis.call('HGETALL', KEYS[1])
    local snapshot = {}
    for i = 1, #fields, 2 do snapshot[fields[i]] = fields[i + 1] end
    return snapshot
  end
  return cjson.decode(redis.call('GET', KEYS[1]) or '{}')
end
local session = loadSession()
local function record(run)
  local raw = session['run:' .. run]
  if not raw then error('Missing admission record') end
  return cjson.decode(raw)
end
local function count(key)
  return tonumber(redis.call('GET', key) or '0')
end
local function remaining(first)
  local left = nil
  for i, limit in ipairs(p.dailyLimits) do
    local available = math.max(0, limit - count(KEYS[first + i - 1]))
    if left == nil or available < left then left = available end
  end
  return left
end
`;

// KEYS: session, lock, minute window, one (member) or two (guest) day counters.
export const ADMIT_SCRIPT = `${COMMON}
local ticket = p.ticket
local now = ticket.acceptedAtMs
local lock = redis.call('GET', KEYS[2])
local duplicate = session['msg:' .. p.clientMsgId]
-- ⑥ duplicates win over every other gate and never mutate stored values.
if duplicate then
  local old = record(duplicate)
  local state = 'unsettled'
  if lock == old.ticket.runId and now < old.ticket.lockExpiresAtMs then
    state = 'running'
  elseif old.settled then
    state = 'settled'
  end
  return cjson.encode({kind = 'duplicate', ticket = old.ticket, state = state})
end
-- ⑦ check the actual lock owner; expired runs must be settled by the caller first.
if lock then
  local owner = record(lock)
  if now < owner.ticket.lockExpiresAtMs then
    return cjson.encode({kind = 'rejected', code = 30506})
  end
end
local last = session.last
if last then
  local old = record(last)
  if not old.settled then
    return cjson.encode({kind = 'unsettled', ticket = old.ticket})
  end
end
-- ⑧ do not trim expired entries until acceptance: even a rejected request is read-only.
local lower = '(' .. string.format('%.0f', now - 60000)
local used = redis.call('ZCOUNT', KEYS[3], lower, '+inf')
if used >= p.limits.perMinute then
  local oldest = redis.call('ZRANGEBYSCORE', KEYS[3], lower, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  local wait = 60
  if #oldest > 0 then wait = math.max(1, math.ceil((tonumber(oldest[2]) + 60000 - now) / 1000)) end
  return cjson.encode({kind = 'rejected', code = 42901, retryAfterSeconds = wait})
end
-- ⑨ rounds do not reset with the day and are never refunded.
local rounds = tonumber(session.rounds or '0')
if rounds >= p.limits.maxRounds then
  return cjson.encode({kind = 'rejected', code = 30504, reason = 'round_limit'})
end
-- ⑩ read every day counter before the first write.
local counts = {}
for i, limit in ipairs(p.dailyLimits) do
  counts[i] = count(KEYS[3 + i])
  if counts[i] >= limit then
    return cjson.encode({kind = 'rejected', code = 30502, resetAt = p.resetAt, next = p.next})
  end
end
-- A run id is generated once per request by the caller; never overwrite an older ticket.
if session['run:' .. ticket.runId] then
  return redis.error_reply('Admission run id reused')
end
local encoded = cjson.encode({ticket = ticket, settled = false, refunded = false})
session['msg:' .. p.clientMsgId] = ticket.runId
session['run:' .. ticket.runId] = encoded
session.last = ticket.runId
session.rounds = tostring(rounds + 1)
local snapshot = cjson.encode(session)
redis.call('SET', KEYS[1], snapshot, 'EX', ttl)
redis.call('SET', KEYS[2], ticket.runId, 'EX', ttl)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', string.format('%.0f', now - 60000))
redis.call('ZADD', KEYS[3], now, p.windowMember)
redis.call('EXPIRE', KEYS[3], ttl)
local left = nil
for i, limit in ipairs(p.dailyLimits) do
  redis.call('SET', KEYS[3 + i], counts[i] + 1, 'EX', ttl)
  local available = limit - counts[i] - 1
  if left == nil or available < left then left = available end
end
return cjson.encode({kind = 'accepted', ticket = ticket, quotaLeft = left})
`;

// KEYS: session, lock, acceptance-day counters, settlement-day counters (may repeat).
export const SETTLE_SCRIPT = `${COMMON}
local old = record(p.ticket.runId)
local t = old.ticket
local supplied = p.ticket
-- Counters are selected by the supplied ticket; ensure it is the accepted ticket before refund.
local sameSubject = t.subject.tier == supplied.subject.tier
if t.subject.tier == 'member' then
  sameSubject = sameSubject and t.subject.userId == supplied.subject.userId
else
  sameSubject = sameSubject and t.subject.deviceHash == supplied.subject.deviceHash
    and t.subject.ipKey == supplied.subject.ipKey
end
if not sameSubject or t.sessionId ~= supplied.sessionId or t.dayKey ~= supplied.dayKey
  or t.messageId ~= supplied.messageId or t.acceptedAtMs ~= supplied.acceptedAtMs
  or t.lockExpiresAtMs ~= supplied.lockExpiresAtMs then
  return redis.error_reply('Admission ticket mismatch')
end
local n = #p.dailyLimits
local currentFirst = 3 + n
if old.settled then
  return cjson.encode({refunded = old.refunded, quotaLeft = remaining(currentFirst)})
end
local lock = redis.call('GET', KEYS[2])
local counts = {}
for i = 1, n do counts[i] = count(KEYS[2 + i]) end
-- Read today's counters before any write as well (including the cross-day case).
local today = {}
for i = 1, n do today[i] = count(KEYS[currentFirst + i - 1]) end
old.settled = true
old.refunded = p.refund
local encoded = cjson.encode(old)
session['run:' .. t.runId] = encoded
local snapshot = cjson.encode(session)
redis.call('SET', KEYS[1], snapshot, 'EX', ttl)
if lock == t.runId then redis.call('DEL', KEYS[2]) end
local left = nil
for i, limit in ipairs(p.dailyLimits) do
  if p.refund then
    local refundedCount = math.max(0, counts[i] - 1)
    redis.call('SET', KEYS[2 + i], refundedCount, 'EX', ttl)
    if KEYS[2 + i] == KEYS[currentFirst + i - 1] then today[i] = refundedCount end
  end
  local available = math.max(0, limit - today[i])
  if left == nil or available < left then left = available end
end
return cjson.encode({refunded = old.refunded, quotaLeft = left})
`;
