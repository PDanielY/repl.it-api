const { CookieJar } = require('tough-cookie')
const nodeFetch = require('node-fetch')
const fetchCookie = require('fetch-cookie')
const WebSocketClient = require('websocket').client

const parseJson = (response) => response.json()
const sendJson = (connection, json) => connection.sendUTF(JSON.stringify(json))
const headers = {
  'Referer': 'https://repl.it/languages/nodejs',
  'Content-Type': 'application/json'
}

module.exports = class {
  constructor(timeout = 5000) {
    this.got = {}
    this.fetch = fetchCookie(nodeFetch, new CookieJar())
    this.timeout = timeout
  }

  async create(language = 'nodejs') {
    const { id, url, fileNames, slug } = await this.fetch('https://repl.it/data/repls/new', {
      method: 'POST',
      body: JSON.stringify({ language }),
      headers
    }).then(parseJson)
    this.got.id = id
    this.got.url = url
    this.got.slug = slug
    this.got.language = language
    this.got.mainFile = fileNames[0]

    this.got.token = await this.fetch(`https://repl.it/data/repls/${id}/gen_repl_token`, {
      method: 'POST',
      body: JSON.stringify({
        liveCodingToken: null,
        polygott: false
      }),
      headers
    }).then(parseJson)
  }

  async connect() {
    const connection = await new Promise((resolve, reject) => {
      const client = new WebSocketClient()
  
      client.on('connectFailed', (error) => {
        reject(error)
      })
  
      client.on('connect', (connection) => {
        resolve(connection)
      })
  
      client.connect('wss://eval.repl.it/ws')
    })
    await new Promise((resolve) => {
      sendJson(connection, {
        command: 'auth',
        data: this.got.token
      })
      connection.on('message', ({ type, utf8Data }) => {
        if (type !== 'utf8') return
        const { command } = JSON.parse(utf8Data)
        if (command === 'ready') resolve()
      })
    })
    this.got.connection = connection
  }

  async write(name, content) {
    const json = await this.fetch(`https://repl.it/data/repls/signed_urls/${this.got.id}/${encodeURIComponent(name)}?d=${Date.now()}`).then(parseJson)
    const writeUrl = json.urls_by_action.write
    await this.fetch(writeUrl, {
      method: 'PUT',
      body: content,
      headers: {
        'Content-Type': ''
      }
    })
  }

  writeMain(content) {
    return this.write(this.got.mainFile, content)
  }

  run(listeners = {}) {
    const { output, timedOut, listen, installStart, installOutput, installEnd } = listeners
    let alreadyLeft = false
    let timeout

    return new Promise((resolve) => {
      const timeoutAmount = this.timeout
      function setTheTimeout() {
        timeout = setTimeout(() => {
          if (alreadyLeft) return
          alreadyLeft = true
          timedOut && timedOut()
          resolve()
        }, timeoutAmount)
      }

      sendJson(this.got.connection, {
        command: 'runProject',
        data: '[]'
      })
      setTheTimeout()
      this.got.connection.on('message', ({ type, utf8Data }) => {
        if (type !== 'utf8') return
        const { command, data } = JSON.parse(utf8Data)

        if (command === 'event:packageInstallStart') {
          clearTimeout(timeout)
          installStart && installStart()
        } else if (installOutput && command === 'event:packageInstallOutput') {
          installOutput(data)
        } else if (command === 'event:packageInstallEnd') {
          setTheTimeout()
          installEnd && installEnd()
        } else if (output && command === 'output') {
          output(data)
        } else if (command === 'result' && !alreadyLeft) {
          alreadyLeft = true
          resolve(data)
        } else if (command === 'event:portOpen') {
          const { port } = JSON.parse(data)
          alreadyLeft = true
          listen && listen(port)
          resolve()
        }
      })
    })
  }

  close() {
    return new Promise((resolve) => {
      this.got.connection.close()
      this.got.connection.on('close', () => {
        resolve()
      })
    })
  }

  getInfo() {
    return {
      id: this.got.id,
      url: `https://repl.it${this.got.url}`,
      slug: this.got.slug,
      language: this.got.language
    }
  }
}