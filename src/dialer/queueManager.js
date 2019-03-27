'use strict'

const once = require('once')
const Queue = require('./queue')

const noop = () => {}

const MAX_PARALLEL_DIALS = 10

class DialQueueManager {
  /**
   * @constructor
   * @param {Switch} _switch
   */
  constructor (_switch) {
    this._queue = []
    this._queues = {}
    this.switch = _switch
    this.dials = 0
  }

  /**
   * Iterates over all items in the DialerQueue
   * and executes there callback with an error.
   *
   * This causes the entire DialerQueue to be drained
   */
  abort () {
    const queues = Object.values(this._queues)
    queues.forEach(dialQueue => {
      dialQueue.abort()
    })
  }

  /**
   * Adds the `dialRequest` to the queue and ensures the queue is running
   *
   * @param {DialRequest} dialRequest
   */
  add ({ peerInfo, protocol, useFSM, callback }) {
    callback = callback ? once(callback) : noop

    this._queue.push({ peerInfo, protocol, useFSM, callback })
    this.run()
  }

  /**
   * Will execute up to `MAX_PARALLEL_DIALS` dials
   */
  run () {
    if (this.dials < MAX_PARALLEL_DIALS && this._queue.length > 0) {
      let { peerInfo, protocol, useFSM, callback } = this._queue.shift()
      let dialQueue = this.getQueue(peerInfo)
      if (!dialQueue.isRunning) {
        this.dials++
      }
      dialQueue.add(protocol, useFSM, callback)
    }
  }

  onQueueStopped () {
    this.dials--
    this.run()
  }

  /**
   * Returns the `Queue` for the given `peerInfo`
   * @param {PeerInfo} peerInfo
   * @returns {Queue}
   */
  getQueue (peerInfo) {
    const id = peerInfo.id.toB58String()

    this._queues[id] = this._queues[id] || new Queue(id, this.switch, this.onQueueStopped.bind(this))
    return this._queues[id]
  }
}

module.exports = DialQueueManager
