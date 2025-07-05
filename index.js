const log = require('debug')('stream')
const log_redis = log.extend('redis')

const ioredis = require('ioredis')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const helmet = require('helmet')
const morganDebug = require('morgan-debug')
const W3CWebSocket = require('websocket').w3cwebsocket

let upstreamMessageCount = 0
let upstreamConnectCount = 0

const redis = new ioredis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: [1, '1', true, 'true', 'yes', 'YES', 'y', 'Y'].indexOf(process.env.REDIS_TLS) > -1,
  autoResendUnfulfilledCommands: true,
  maxRetriesPerRequest: null
})

redis.on('connect', _ => log_redis('REDIS connected'))
redis.on('ready', _ => log_redis('REDIS ready'))
redis.on('close', _ => log_redis('REDIS disconnected'))
redis.on('error', e => log_redis('Error', e))

const tempStoreMsg = (batchHash, message) => {
  try {
    const key = batchHash + '_' + new Date() / 1 + '_' + upstreamMessageCount
    const exp = 60 * 30 // 60 seconds times 30 minutes

    // log_redis('set', key)
    redis.set('msg:' + key, message, 'ex', exp)
    redis.incr('batch:' + batchHash)
    redis.expire('batch:' + batchHash, exp)
  } catch (e) {
    log_redis('Error', e)
  }
}

const streamClientMessage = msg => {
  if (msg !== '') {
    if (msg.match(/reportConsensusStateChange/)) return

    upstreamMessageCount++
    const batchTraceMatch = msg.match(/BatchTrace\[([A-F0-9]{64})\]/g)

    if (batchTraceMatch) {
      const uniqueBatches = [...new Set(batchTraceMatch.map(match => {
        const hashMatch = match.match(/BatchTrace\[([A-F0-9]{64})\]/)
        return hashMatch ? hashMatch[1] : null
      }).filter(Boolean))]

      log('MSG for batches', uniqueBatches.join(', '))
      uniqueBatches.forEach(batchHash => {
        tempStoreMsg(batchHash, msg)

        expressWs.getWss().clients.forEach(c => {
          if (c?.subscriptionType === 'batch' && (!c?.batchHash || c?.batchHash === batchHash)) {
            c.send(msg)
            c.batchMessages++
          }
        })
      })
    }
  }
}

let upstreamConnected = false

const startStreamClient = () => {
  upstreamConnectCount++

  log('Start Stream Client')
  const client = new W3CWebSocket(process.env?.ENDPOINT || 'ws://localhost:1400')

  const destruct = () => {
    client.onerror = null
    client.onmessage = null
    client.onopen = null
    client.onclose = null
    delete client
    upstreamConnected = false
  }

  let timeout = setTimeout(() => {
    log('DESTRUCT, COULD NOT CONNECT')
    destruct()
  }, 5000)

  client.onerror = () => {
    log('UPSTREAM Connection Error')

    destruct()
  }
  
  client.onopen = () => {
    log('UPSTREAM  WebSocket Client Connected', client.readyState === client.OPEN)
    upstreamConnected = true
    clearTimeout(timeout)
  }
  
  client.onclose = () => {
    log('UPSTREAM Client Closed')

    destruct()
  }

  let data = ''
  let flushTimeout
  
  client.onmessage = e => {
    if (typeof e.data === 'string') {
      if (e.data.match(/INSERT INTO AccountTransactions/)) {
        // Ignore
        return
      }

      clearTimeout(flushTimeout)

      if (e.data.match(/^[0-9]{4}-[A-Za-z]{3}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/)) {
        streamClientMessage(data.trim())
        data = ''
      }

      data += `\n` + e.data

      flushTimeout = setTimeout(() => {
        if (data.trim() !== '') {
          streamClientMessage(data.trim())
          // log('____FLUSH___', data)
          data = ''
        }
      }, 500)
    }
  }  
}

startStreamClient()

setInterval(() => {
  if (!upstreamConnected) {
    startStreamClient()
  }
}, 10000)

const PORT = process.env?.PORT || 8080
const app = express()
var expressWs = require('express-ws')(app)

log.log = console.log.bind(console)

app.use(bodyParser.json())
app.use(helmet())
app.use(express.static(__dirname + '/public'))
app.use(morganDebug('stream:httplog', 'combined'))

app.use(cors({
  origin: (process.env?.CORS_ORIGINS || '*').replace(/ +/g, ',').split(','),
  // methods: 'GET, POST, OPTIONS'
}))

// WebSocket endpoint for all batch transactions
app.ws('/batch', (ws, req) => {
  try {
    log('WebSocket connection for all batch transactions')
  
    Object.assign(ws, {
      subscriptionType: 'batch',
      batchHash: null, // null means listen to all batches
      batchMessages: 0
    })

    ws.on('message', () => {
      ws.send('batch_all')
    })

  } catch (e) {
    ws.send(JSON.stringify({
      msg: e.message,
      error: true
    }))

    log(e.message)

    process.nextTick(() => {
      ws.close(4000, e.message)
    })
  }
})

// WebSocket endpoint for specific batch hash
app.ws('/batch/:hash([A-F0-9]{64})', (ws, req) => {
  try {
    const batchHash = (req.params?.hash || '').trim().toUpperCase()

    if (!batchHash.match(/^[A-F0-9]{64}$/)) {
      throw new Error('Invalid batch hash: ' + batchHash)
    }

    log('WebSocket connection for batch', batchHash)
  
    Object.assign(ws, {
      subscriptionType: 'batch',
      batchHash,
      batchMessages: 0
    })

    ws.on('message', () => {
      ws.send(batchHash)
    })

  } catch (e) {
    ws.send(JSON.stringify({
      msg: e.message,
      error: true
    }))

    log(e.message)

    process.nextTick(() => {
      ws.close(4000, e.message)
    })
  }
})

app.get('/', async (req, res) => {
  res.status(404).json({
    msg: 'Connect using a WebSocket client to /batch for all batch transactions or /batch/{hash} for specific batch',
    error: true
  })
})

app.get('/recent/batches', async (req, res) => {
  return res.json({
    batches: (await redis.keys('batch:*')).map(k => k.slice(6))
  })
})

app.get('/recent/batch/:hash([A-F0-9]{64})', async (req, res) => {
  const batchHash = req.params.hash.toUpperCase()
  const logs = (await Promise.all((await redis.keys('msg:' + batchHash + '_*'))
    .map(async l => {
      const m = l.slice(4).split('_')
      return {
        timestamp: m[1],
        data: await redis.get(l)
      }
    }))).reduce((a, b) => {
      a[b.timestamp] = b.data
      return a
    }, {})

  return res.json({
    batch: batchHash,
    messages: Number(await redis.get('batch:' + batchHash) || 0),
    logs: Object.keys(logs).sort().reduce((a, b) => {
      a[b] = logs[b]
      return a
    }, {})
  })
})

app.get('/status', async (req, res) => {
  res.json({
    upstreamMessages: upstreamMessageCount,
    upstreamConnections: upstreamConnectCount,
    connections: expressWs.getWss().clients.size,
    subscriptions: [ ...expressWs.getWss().clients.values() ].map(c => {
      return {
        type: c?.subscriptionType,
        batch: c?.batchHash || 'all',
        messages: c?.batchMessages || 0
      }
    }).reduce((a, b) => {
      const key = b.type + '_' + b.batch
      Object.assign(a, {
        [key]: {
          messages: (a[key]?.messages || 0) + b.messages,
          connections: (a[key]?.connections || 0) + 1
        }
      })
      return a
    }, {})
  })
})

app.get('/batch', 
  (req, res, next) => {
    req.url = '/'
    next()
  },
  express.static(__dirname + '/public', { index: 'client.html' }))

app.get('/batch/:hash([A-F0-9]{64})', 
  (req, res, next) => {
    req.url = '/'
    next()
  },
  express.static(__dirname + '/public', { index: 'client.html' }))

app.get('*', async (req, res) => {
  res.status(404).json({
    msg: 'Not found',
    error: true
  })
})

app.listen(PORT, () => {
  require('dns').lookup(require('os').hostname(), async (err, adr, fam) => {
    log(`\nApp listening at http://${adr}:${PORT}`)
    log(`                 http://localhost:${PORT}`)
  })
})
