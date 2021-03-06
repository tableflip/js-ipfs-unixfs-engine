'use strict'

const waterfall = require('async/waterfall')
const dagPB = require('ipld-dag-pb')
const UnixFS = require('ipfs-unixfs')
const CID = require('cids')

const DAGLink = dagPB.DAGLink
const DAGNode = dagPB.DAGNode

module.exports = function reduce (file, ipld, options) {
  return function (leaves, callback) {
    if (leaves.length === 1 && leaves[0].single && options.reduceSingleLeafToSelf) {
      const leaf = leaves[0]

      if (options.leafType === 'file' && !options.rawLeaves) {
        return callback(null, {
          path: file.path,
          multihash: leaf.multihash,
          size: leaf.size,
          leafSize: leaf.leafSize,
          name: leaf.name
        })
      }

      // we're using raw leaf nodes so we convert the node into a UnixFS `file` node.
      return waterfall([
        (cb) => ipld.get(leaf.cid, cb),
        (result, cb) => {
          // If result.value is a buffer, this is a raw leaf otherwise it's a dag-pb node
          const data = Buffer.isBuffer(result.value) ? result.value : result.value.data
          const fileNode = new UnixFS('file', data)

          DAGNode.create(fileNode.marshal(), [], options.hashAlg, (error, node) => {
            cb(error, { DAGNode: node, fileNode: fileNode })
          })
        },
        (result, cb) => {
          if (options.onlyHash) {
            return cb(null, result)
          }

          let cid = new CID(result.DAGNode.multihash)

          if (options.cidVersion === 1) {
            cid = cid.toV1()
          }

          ipld.put(result.DAGNode, { cid }, (error) => cb(error, result))
        },
        (result, cb) => {
          cb(null, {
            path: file.path,
            multihash: result.DAGNode.multihash,
            size: result.DAGNode.size,
            leafSize: result.fileNode.fileSize(),
            name: leaf.name
          })
        }
      ], callback)
    }

    // create a parent node and add all the leaves
    const f = new UnixFS('file')

    const links = leaves.map((leaf) => {
      f.addBlockSize(leaf.leafSize)

      let cid = leaf.cid

      if (!cid) {
        // we are an intermediate node
        cid = new CID(options.cidVersion, 'dag-pb', leaf.multihash)
      }

      return new DAGLink(leaf.name, leaf.size, cid.buffer)
    })

    waterfall([
      (cb) => DAGNode.create(f.marshal(), links, options.hashAlg, cb),
      (node, cb) => {
        const cid = new CID(options.cidVersion, 'dag-pb', node.multihash)

        if (options.onlyHash) {
          return cb(null, {
            node, cid
          })
        }

        ipld.put(node, {
          cid
        }, (error) => cb(error, {
          node, cid
        }))
      }
    ], (error, result) => {
      if (error) {
        return callback(error)
      }

      callback(null, {
        name: '',
        path: file.path,
        multihash: result.cid.buffer,
        size: result.node.size,
        leafSize: f.fileSize()
      })
    })
  }
}
