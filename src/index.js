'use strict';

const FSM = require('fsm-event')
const EventEmitter = require('events').EventEmitter
const each = require('async/each')
const series = require('async/series')
const TransportManager = require('./transport')
const ConnectionManager = require('./connection')
const getPeerInfo = require('./get-peer-info')
const dial = require('./dial')
const ProtocolMuxer = require('./protocol-muxer')
const plaintext = require('./plaintext')
const Observer = require('./observer')
const Stats = require('./stats')
const assert = require('assert')
const Errors = require('./errors')
const debug = require('debug')
const log = debug('libp2p:switch')

class Switch extends EventEmitter {
  constructor (peerInfo, peerBook, options) {
    super()
    assert(peerInfo, 'You must provide a `peerInfo`')
    assert(peerBook, 'You must provide a `peerBook`')

    this._peerInfo = peerInfo
    this._peerBook = peerBook
    this._options = options || {}

    this.setMaxListeners(Infinity)
    // transports --
    // { key: transport }; e.g { tcp: <tcp> }
    this.transports = {}

    // connections --
    // { peerIdB58: { conn: <conn> }}
    this.conns = {}

    // {
    //   peerIdB58: {
    //     muxer: <muxer>
    //     conn: <transport socket> // to extract info required for the Identify Protocol
    //   }
    // }
    this.muxedConns = {}

    // { protocol: handler }
    this.protocols = {}

    // { muxerCodec: <muxer> } e.g { '/spdy/0.3.1': spdy }
    this.muxers = {}

    // is the Identify protocol enabled?
    this.identify = false

    // Crypto details
    this.crypto = plaintext

    this.protector = this._options.protector || null

    this.transport = new TransportManager(this)
    this.connection = new ConnectionManager(this)

    this.observer = Observer(this)
    this.stats = Stats(this.observer, this._options.stats)
    this.protocolMuxer = ProtocolMuxer(this.protocols, this.observer)

    this.handle(this.crypto.tag, (protocol, conn) => {
      const peerId = this._peerInfo.id
      const wrapped = this.crypto.encrypt(peerId, conn, undefined, () => {})
      return this.protocolMuxer(null)(wrapped)
    })

    // higher level (public) API
    this.dial = dial(this)

    // Setup the internal state
    this.state = new FSM('STOPPED', {
      STOPPED: {
        start: 'STARTING',
        stop: 'STOPPING' // ensures that any transports that were manually started are stopped
      },
      STARTING: {
        done: 'STARTED',
        stop: 'STOPPING'
      },
      STARTED: {
        stop: 'STOPPING',
        start: 'STARTED'
      },
      STOPPING: { done: 'STOPPED' }
    })
    this.state.on('STARTING', () => {
      log('The switch is starting')
      this._onStarting()
    })
    this.state.on('STOPPING', () => {
      log('The switch is stopping')
      this._onStopping()
    })
    this.state.on('STARTED', () => {
      log('The switch has started')
      this.emit('started')
    })
    this.state.on('STOPPED', () => {
      log('The switch has stopped')
      this.emit('stopped')
    })
    this.state.on('error', (err) => this.emit('error', err))
  }

  /**
   * Returns a list of the transports peerInfo has addresses for
   *
   * @param {PeerInfo} peerInfo
   * @returns {Array<Transport>}
   */
  availableTransports (peerInfo) {
    const myAddrs = peerInfo.multiaddrs.toArray()
    const myTransports = Object.keys(this.transports)

    // Only listen on transports we actually have addresses for
    return myTransports.filter((ts) => this.transports[ts].filter(myAddrs).length > 0)
      // push Circuit to be the last proto to be dialed
      .sort((a) => {
        return a === 'Circuit' ? 1 : 0
      })
  }

  /**
   * Adds the `handlerFunc` and `matchFunc` to the Switch's protocol
   * handler list for the given `protocol`. If the `matchFunc` returns
   * true for a protocol check, the `handlerFunc` will be called.
   *
   * @param {string} protocol
   * @param {function(string, Connection)} handlerFunc
   * @param {function(string, string, function(Error, boolean))} matchFunc
   * @returns {void}
   */
  handle (protocol, handlerFunc, matchFunc) {
    this.protocols[protocol] = {
      handlerFunc: handlerFunc,
      matchFunc: matchFunc
    }
  }

  /**
   * Removes the given protocol from the Switch's protocol list
   *
   * @param {string} protocol
   * @returns {void}
   */
  unhandle (protocol) {
    if (this.protocols[protocol]) {
      delete this.protocols[protocol]
    }
  }

  /**
   * If a muxed Connection exists for the given peer, it will be closed
   * and its reference on the Switch will be removed.
   *
   * @param {PeerInfo|Multiaddr|PeerId} peer
   * @param {function()} callback
   * @returns {void}
   */
  hangUp (peer, callback) {
    const peerInfo = getPeerInfo(peer, this.peerBook)
    const key = peerInfo.id.toB58String()
    if (this.muxedConns[key]) {
      const muxer = this.muxedConns[key].muxer
      muxer.once('close', () => {
        delete this.muxedConns[key]
        callback()
      })
      muxer.end()
    } else {
      callback()
    }
  }

  /**
   * Returns whether or not the switch has any transports
   *
   * @returns {boolean}
   */
  hasTransports () {
    const transports = Object.keys(this.transports).filter((t) => t !== 'Circuit')
    return transports && transports.length > 0
  }

  /**
   * Issues a start on the Switch state.
   *
   * @param {function} callback deprecated: Listening for the `error` and `start` events are recommended
   * @fires Switch#started
   * @returns {void}
   */
  start (callback = () => {}) {
    // Add once listener for deprecated callback support
    this.once('started', callback)

    this.state('start')
  }

  /**
   * Issues a stop on the Switch state.
   *
   * @param {function} callback deprecated: Listening for the `error` and `stop` events are recommended
   * @fires Switch#stop
   * @returns {void}
   */
  stop (callback = () => {}) {
    // Add once listener for deprecated callback support
    this.once('stopped', callback)

    this.state('stop')
  }

  /**
   * A listener that will start any necessary services and listeners
   *
   * @fires Switch#error
   * @returns {void}
   */
  _onStarting () {
    each(this.availableTransports(this._peerInfo), (ts, cb) => {
      // Listen on the given transport
      this.transport.listen(ts, {}, null, cb)
    }, (err) => {
      if (err) {
        return this.emit('error', err)
      }
      this.state('done')
    })
  }

  /**
   * A listener that will turn off all running services and listeners
   *
   * @fires Switch#error
   * @returns {void}
   */
  _onStopping () {
    this.stats.stop()
    series([
      (cb) => each(this.muxedConns, (conn, cb) => {
        // If the connection was destroyed while we are hanging up, continue
        if (!conn) {
          return cb()
        }

        conn.muxer.end((err) => {
          // If OK things are fine, and someone just shut down
          if (err && err.message !== 'Fatal error: OK') {
            return cb(err)
          }
          cb()
        })
      }, cb),
      (cb) => {
        each(this.transports, (transport, cb) => {
          each(transport.listeners, (listener, cb) => {
            listener.close(cb)
          }, cb)
        }, cb)
      }
    ], (err) => {
      if (err) {
        console.log('Error', err)
        this.emit('error', err)
      }

      this.state('done')
    })
  }
}

module.exports = Switch
module.exports.errors = Errors
