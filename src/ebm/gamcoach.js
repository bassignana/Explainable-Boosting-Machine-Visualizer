/**
 * The EBM module.
 *
 * Author: Jay Wang (jayw@gatech.edu)
 * License: MIT
 */

/**
 * Find the lower bound of a pair between where inserting `value` into `sorted`
 * would keep `sorted` in order.
 * @param sorted a sorted array (ascending order)
 * @param value a number to insert into `sorted`
 * @returns the lower bound index in the sorted array to insert
 */
function searchSortedLowerIndex(sorted, value) {
  let left = 0;
  let right = sorted.length - 1;

  while (right - left > 1) {
    let i = left + Math.floor((right - left) / 2);

    if (value > sorted[i]) {
      left = i;
    } else if (value < sorted[i]) {
      right = i;
    } else {
      return i;
    }
  }

  // Handle out of bound issue
  if (value >= sorted[right]) {
    return right;
  }
  if (value < sorted[left]) {
    return left;
  }
  return right - 1;
}

function round(num, decimal) {
  return Math.round((num + 2e-16) * 10 ** decimal) / 10 ** decimal;
}

function sigmoid(logit) {
  let odd = Math.exp(logit);

  // Round the prob for more stable ROC AUC computation
  return round(odd / (1 + odd), 5);
}

class EBM {
  /**
   * Initialize an EBM model from a trained EBM model.
   * @param {object} model Trained EBM model in JSON format
   */
  constructor(model) {
    /**
     * Pre-process the feature data
     *
     * Feature data includes the main effect and also the interaction effect, and
     * we want to split those two.
     */

    // Step 1: For the main effect, we only need bin edges and scores stored with the same order
    // of `featureNames` and `featureTypes`.

    // Create an index map from feature name to their index in featureData
    let featureDataNameMap = new Map();
    model.features.forEach((d, i) => featureDataNameMap.set(d.name, i));

    // Create two 2D arrays for binEdge ([feature, bin]) and score ([feature, bin]) respectively
    // We mix continuous and categorical together (assume the categorical features
    // have been encoded)
    let binEdges = [];
    let scores = [];

    // This loop won't encounter interaction terms
    for (let i = 0; i < model.featureNames.length; i++) {
      let curName = model.featureNames[i];
      let curIndex = featureDataNameMap.get(curName);

      let curScore = model.features[curIndex].additive.slice();
      let curBinEdge;

      // Different formats for the categorical data
      if (model.featureTypes[i] === 'categorical') {
        curBinEdge = model.features[curIndex].binLabel.slice();
      } else {
        curBinEdge = model.features[curIndex].binEdge.slice(0, -1);
      }

      binEdges.push(curBinEdge);
      scores.push(curScore);

      console.assert((binEdges.length = scores.length));
    }

    /**
     * Step 2: For the interaction effect, we want to store the feature
     * indexes and the score.
     *
     * Here we store arrays of indexes(2D), edges(3D), and scores(3D)
     */
    let interactionIndexes = [];
    let interactionScores = [];
    let interactionBinEdges = [];

    model.features.forEach((d) => {
      if (d.type === 'interaction') {
        // Parse the feature name
        let index1 = model.featureNames.indexOf(d.name1);
        let index2 = model.featureNames.indexOf(d.name2);

        let curIndexes = [index1, index2];
        interactionIndexes.push(curIndexes);

        // Collect two bin edges
        let binEdge1 = [];
        let binEdge2 = [];

        // Have to skip the max edge if it is continuous
        if (model.featureTypes[index1] === 'categorical') {
          binEdge1 = d.binLabel1.slice();
        } else {
          binEdge1 = d.binLabel1.slice(0, -1);
        }

        if (model.featureTypes[index2] === 'categorical') {
          binEdge2 = d.binLabel2.slice();
        } else {
          binEdge2 = d.binLabel2.slice(0, -1);
        }

        let curBinEdges = [binEdge1, binEdge2];
        interactionBinEdges.push(curBinEdges);

        // Add the scores
        let curScore2D = d.additive;
        interactionScores.push(curScore2D);

        console.assert(binEdge1.length === curScore2D.length);
        console.assert(binEdge2.length === curScore2D[0].length);
      }
    });

    // Step 3: Deal with categorical encodings
    // int => string
    let labelDecoder = model.labelEncoder;

    let labelEncoder = {};
    Object.keys(labelDecoder).forEach((f) => {
      labelEncoder[f] = {};
      Object.keys(labelDecoder[f]).forEach((l) => {
        labelEncoder[f][labelDecoder[f][l]] = l;
      });
    });

    // Initialize attributes
    this.featureNames = model.featureNames;
    this.featureTypes = model.featureTypes;
    this.binEdges = binEdges;
    this.scores = scores;
    this.intercept = model.intercept;
    this.interactionIndexes = interactionIndexes;
    this.interactionBinEdges = interactionBinEdges;
    this.interactionScores = interactionScores;
    this.isClassifier = model.isClassifier;
    this.labelDecoder = labelDecoder;
    this.labelEncoder = labelEncoder;
  }

  /**
   * Count the score of all features for the given sample
   * @param {[object]} sample One data point to predict on
   */
  countScore(sample) {
    let binScores = {};

    // Step 1: Encode categorical level strings to integers
    let encodedSample = sample.slice();
    for (let j = 0; j < sample.length; j++) {
      if (this.featureTypes[j] === 'categorical') {
        let curEncoder = this.labelEncoder[this.featureNames[j]];

        if (curEncoder[sample[j]] !== undefined) {
          encodedSample[j] = parseInt(curEncoder[sample[j]], 10);
        } else {
          // Unseen level
          // Because level code starts at index 1, 0 would trigger a miss
          // during inference => 0 score
          encodedSample[j] = 0;
        }
      }
    }

    // Step 1: Iterate through all columns to count for main effect
    for (let j = 0; j < encodedSample.length; j++) {
      let curFeatureName = this.featureNames[j];
      let curFeatureType = this.featureTypes[j];
      let curFeature = encodedSample[j];

      // Use the feature value to find the corresponding bin
      let binIndex = -1;
      let binScore = 0;

      if (curFeatureType === 'continuous') {
        binIndex = searchSortedLowerIndex(this.binEdges[j], curFeature);
        binScore = this.scores[j][binIndex];
      } else {
        binIndex = this.binEdges[j].indexOf(curFeature);

        if (binIndex < 0) {
          // Unseen level during training => use 0 as score instead
          console.log(
            `Unseen categorical level: ${curFeatureName}, ${j}, ${curFeature}`
          );
          binScore = 0;
        } else {
          binScore = this.scores[j][binIndex];
        }
      }

      // Record the current feature score
      binScores[curFeatureName] = binScore;
    }

    // Step 2: Add interaction effect scores
    for (let j = 0; j < this.interactionIndexes.length; j++) {
      let curIndexes = this.interactionIndexes[j];

      // Look up the names and types
      let name1 = this.featureNames[curIndexes[0]];
      let name2 = this.featureNames[curIndexes[1]];

      let type1 = this.featureTypes[curIndexes[0]];
      let type2 = this.featureTypes[curIndexes[1]];

      let value1 = encodedSample[curIndexes[0]];
      let value2 = encodedSample[curIndexes[1]];

      // Figure out which bin to query along two dimensions
      let binIndex1 = -1;
      let binIndex2 = -1;

      if (type1 === 'continuous') {
        binIndex1 = searchSortedLowerIndex(
          this.interactionBinEdges[j][0],
          value1
        );
      } else {
        binIndex1 = this.interactionBinEdges[j][0].indexOf(value1);
      }

      if (type2 === 'continuous') {
        binIndex2 = searchSortedLowerIndex(
          this.interactionBinEdges[j][1],
          value2
        );
      } else {
        binIndex2 = this.interactionBinEdges[j][1].indexOf(value2);
      }

      // Query the bin scores
      let binScore = 0;

      if (binIndex1 < 0 || binIndex2 < 0) {
        binScore = 0;
      } else {
        binScore = this.interactionScores[j][binIndex1][binIndex2];
      }

      // Record the current feature score
      binScores[`${name1} x ${name2}`] = binScore;
    }

    return binScores;
  }

  /**
   * Get the predictions on the given samples.
   * @param {[[object]]} samples 2D array of samples (n_samples, n_features)
   * @param {bool} rawScore True if you want to get the original score (log odd
   * for binary classification)
   */
  predict(samples, rawScore = false) {
    console.assert(samples.length > 0 && samples[0].length > 0);

    let predictions = [];

    for (let i = 0; i < samples.length; i++) {
      let curSample = samples[i];
      let binScores = this.countScore(curSample);

      // Get the additive prediction by summing up scores and intercept
      let predScore = Object.values(binScores).reduce((a, b) => a + b);
      predScore += this.intercept;

      // Convert the prediction to 1/0 if it is binary classification
      if (this.isClassifier && !rawScore) {
        predScore = sigmoid(predScore) >= 0.5 ? 1 : 0;
      }
      predictions.push(predScore);
    }

    return predictions;
  }

  /**
   * Get the predicted probabilities on the given samples.
   * @param {*} samples 2D array of samples (n_samples, n_features)
   */
  predictProb(samples) {
    console.assert(samples.length > 0 && samples[0].length > 0);

    let predictions = [];

    for (let i = 0; i < samples.length; i++) {
      let curSample = samples[i];
      let binScores = this.countScore(curSample);

      // Get the additive prediction by summing up scores and intercept
      let predScore = Object.values(binScores).reduce((a, b) => a + b);
      predScore += this.intercept;

      // Convert the prediction to 1/0 if it is binary classification
      if (this.isClassifier) {
        predScore = sigmoid(predScore);
      }
      predictions.push(predScore);
    }

    return predictions;
  }
}

/**
 * The EBM sub-class designed for one single sample point
 *
 * Author: Jay Wang (jayw@gatech.edu)
 * License: MIT
 */

/**
 * A unique EBM class designed to predict only one fixed sample point. It can
 * efficiently update the prediction when a feature of this point is changed.
 */
class EBMLocal extends EBM {
  sample;
  predScores;
  predProb;
  pre;

  /**
   * Initialize the EBMLocal object.
   * @param {object} model Trained EBM model in JSON format
   * @param {[object]} sample A single data point of interest
   */
  constructor(model, sample) {
    // Init the ancestor EBM class
    super(model);

    this.sample = sample.slice();

    // Make an initial prediction on this sample and record the predictions
    this.countedScores = this.countScore(sample);
    this.predScore =
      Object.values(this.countedScores).reduce((a, b) => a + b) +
      this.intercept;
    this.predProb = this.isClassifier
      ? sigmoid(this.predScore)
      : this.predScore;
    this.pred = this.isClassifier
      ? this.predProb >= 0.5
        ? 1
        : 0
      : this.predScore;
  }

  /**
   * Update a feature of `sample` and the its predictions
   * @param {string} name Feature name.
   * @param {object} value New feature value. For categorical features, it is a string
   * corresponding to the new level.
   */
  updateFeature(name, value) {
    let index = this.featureNames.indexOf(name);
    let curType = this.featureTypes[index];

    if (curType !== 'continuous' && curType !== 'categorical') {
      throw new Error(
        'Only continuous and categorical features can be updated'
      );
    }

    // Step 1: Update the value in the sample attribute (keep the original level
    // string)
    this.sample[index] = value;
    let encodedSample = this.sample.slice();

    // Step 2: Encode all categorical values
    for (let j = 0; j < encodedSample.length; j++) {
      if (this.featureTypes[j] === 'categorical') {
        let curEncoder = this.labelEncoder[this.featureNames[j]];

        if (curEncoder[encodedSample[j]] !== undefined) {
          encodedSample[j] = parseInt(curEncoder[encodedSample[j]], 10);
        } else {
          // Unseen level
          // Because level code starts at index 1, 0 would trigger a miss
          // during inference => 0 score
          encodedSample[j] = 0;
        }
      }
    }

    // Step 3: Look up the new value
    let curFeature = encodedSample[index];
    let binIndex = -1;
    let binScore = 0;

    if (curType === 'continuous') {
      binIndex = searchSortedLowerIndex(this.binEdges[index], curFeature);
      binScore = this.scores[index][binIndex];
    } else {
      binIndex = this.binEdges[index].indexOf(curFeature);

      if (binIndex < 0) {
        // Unseen level during training => use 0 as score instead
        console.log(
          `Unseen categorical level: ${name}, ${index}, ${curFeature}`
        );
        binScore = 0;
      } else {
        binScore = this.scores[index][binIndex];
      }
    }

    this.countedScores[name] = binScore;

    // Step 3: Trigger an interaction look up if necessary
    for (let j = 0; j < this.interactionIndexes.length; j++) {
      let curIndexes = this.interactionIndexes[j];

      // Look up the names and types
      let name1 = this.featureNames[curIndexes[0]];
      let name2 = this.featureNames[curIndexes[1]];

      if (name1 === name || name2 === name) {
        let type1 = this.featureTypes[curIndexes[0]];
        let type2 = this.featureTypes[curIndexes[1]];

        let value1 = encodedSample[curIndexes[0]];
        let value2 = encodedSample[curIndexes[1]];

        // Figure out which bin to query along two dimensions
        let binIndex1 = -1;
        let binIndex2 = -1;

        if (type1 === 'continuous') {
          binIndex1 = searchSortedLowerIndex(
            this.interactionBinEdges[j][0],
            value1
          );
        } else {
          binIndex1 = this.interactionBinEdges[j][0].indexOf(value1);
        }

        if (type2 === 'continuous') {
          binIndex2 = searchSortedLowerIndex(
            this.interactionBinEdges[j][1],
            value2
          );
        } else {
          binIndex2 = this.interactionBinEdges[j][1].indexOf(value2);
        }

        // Query the bin scores
        let interBinScore = 0;

        if (binIndex1 < 0 || binIndex2 < 0) {
          interBinScore = 0;
        } else {
          interBinScore = this.interactionScores[j][binIndex1][binIndex2];
        }

        // Record the current feature score
        this.countedScores[`${name1} x ${name2}`] = interBinScore;
      }
    }

    // Step 4: Update all predictions
    this.predScore =
      Object.values(this.countedScores).reduce((a, b) => a + b) +
      this.intercept;
    this.predProb = this.isClassifier
      ? sigmoid(this.predScore)
      : this.predScore;
    this.pred = this.isClassifier
      ? this.predProb >= 0.5
        ? 1
        : 0
      : this.predScore;
  }
}

/*! pako 2.0.4 https://github.com/nodeca/pako @license (MIT AND Zlib) */
function t(t) {
  let e = t.length;
  for (; --e >= 0; ) t[e] = 0;
}
const r = new Array(576);
t(r);
const s = new Array(60);
t(s);
const o = new Array(512);
t(o);
const l = new Array(256);
t(l);
const h = new Array(29);
t(h);
const d = new Array(30);
t(d);
var A = (t, e, a, i) => {
  let n = (65535 & t) | 0,
    r = ((t >>> 16) & 65535) | 0,
    s = 0;
  for (; 0 !== a; ) {
    (s = a > 2e3 ? 2e3 : a), (a -= s);
    do {
      (n = (n + e[i++]) | 0), (r = (r + n) | 0);
    } while (--s);
    (n %= 65521), (r %= 65521);
  }
  return n | (r << 16) | 0;
};
const j = new Uint32Array(
  (() => {
    let t,
      e = [];
    for (var a = 0; a < 256; a++) {
      t = a;
      for (var i = 0; i < 8; i++) t = 1 & t ? 3988292384 ^ (t >>> 1) : t >>> 1;
      e[a] = t;
    }
    return e;
  })()
);
var N = (t, e, a, i) => {
    const n = j,
      r = i + a;
    t ^= -1;
    for (let a = i; a < r; a++) t = (t >>> 8) ^ n[255 & (t ^ e[a])];
    return -1 ^ t;
  },
  D = {
    2: 'need dictionary',
    1: 'stream end',
    0: '',
    '-1': 'file error',
    '-2': 'stream error',
    '-3': 'data error',
    '-4': 'insufficient memory',
    '-5': 'buffer error',
    '-6': 'incompatible version'
  },
  V = {
    Z_NO_FLUSH: 0,
    Z_PARTIAL_FLUSH: 1,
    Z_SYNC_FLUSH: 2,
    Z_FULL_FLUSH: 3,
    Z_FINISH: 4,
    Z_BLOCK: 5,
    Z_TREES: 6,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_NO_COMPRESSION: 0,
    Z_BEST_SPEED: 1,
    Z_BEST_COMPRESSION: 9,
    Z_DEFAULT_COMPRESSION: -1,
    Z_FILTERED: 1,
    Z_HUFFMAN_ONLY: 2,
    Z_RLE: 3,
    Z_FIXED: 4,
    Z_DEFAULT_STRATEGY: 0,
    Z_BINARY: 0,
    Z_TEXT: 1,
    Z_UNKNOWN: 2,
    Z_DEFLATED: 8
  };
const Ut = (t, e) => Object.prototype.hasOwnProperty.call(t, e);
var Lt = function (t) {
    const e = Array.prototype.slice.call(arguments, 1);
    for (; e.length; ) {
      const a = e.shift();
      if (a) {
        if ('object' != typeof a) throw new TypeError(a + 'must be non-object');
        for (const e in a) Ut(a, e) && (t[e] = a[e]);
      }
    }
    return t;
  },
  Ot = (t) => {
    let e = 0;
    for (let a = 0, i = t.length; a < i; a++) e += t[a].length;
    const a = new Uint8Array(e);
    for (let e = 0, i = 0, n = t.length; e < n; e++) {
      let n = t[e];
      a.set(n, i), (i += n.length);
    }
    return a;
  };
let St = !0;
try {
  String.fromCharCode.apply(null, new Uint8Array(1));
} catch (t) {
  St = !1;
}
const Kt = new Uint8Array(256);
for (let t = 0; t < 256; t++)
  Kt[t] =
    t >= 252
      ? 6
      : t >= 248
      ? 5
      : t >= 240
      ? 4
      : t >= 224
      ? 3
      : t >= 192
      ? 2
      : 1;
Kt[254] = Kt[254] = 1;
var Rt = (t) => {
    if ('function' == typeof TextEncoder && TextEncoder.prototype.encode)
      return new TextEncoder().encode(t);
    let e,
      a,
      i,
      n,
      r,
      s = t.length,
      o = 0;
    for (n = 0; n < s; n++)
      (a = t.charCodeAt(n)),
        55296 == (64512 & a) &&
          n + 1 < s &&
          ((i = t.charCodeAt(n + 1)),
          56320 == (64512 & i) &&
            ((a = 65536 + ((a - 55296) << 10) + (i - 56320)), n++)),
        (o += a < 128 ? 1 : a < 2048 ? 2 : a < 65536 ? 3 : 4);
    for (e = new Uint8Array(o), r = 0, n = 0; r < o; n++)
      (a = t.charCodeAt(n)),
        55296 == (64512 & a) &&
          n + 1 < s &&
          ((i = t.charCodeAt(n + 1)),
          56320 == (64512 & i) &&
            ((a = 65536 + ((a - 55296) << 10) + (i - 56320)), n++)),
        a < 128
          ? (e[r++] = a)
          : a < 2048
          ? ((e[r++] = 192 | (a >>> 6)), (e[r++] = 128 | (63 & a)))
          : a < 65536
          ? ((e[r++] = 224 | (a >>> 12)),
            (e[r++] = 128 | ((a >>> 6) & 63)),
            (e[r++] = 128 | (63 & a)))
          : ((e[r++] = 240 | (a >>> 18)),
            (e[r++] = 128 | ((a >>> 12) & 63)),
            (e[r++] = 128 | ((a >>> 6) & 63)),
            (e[r++] = 128 | (63 & a)));
    return e;
  },
  At = (t, e) => {
    const a = e || t.length;
    if ('function' == typeof TextDecoder && TextDecoder.prototype.decode)
      return new TextDecoder().decode(t.subarray(0, e));
    let i, n;
    const r = new Array(2 * a);
    for (n = 0, i = 0; i < a; ) {
      let e = t[i++];
      if (e < 128) {
        r[n++] = e;
        continue;
      }
      let s = Kt[e];
      if (s > 4) (r[n++] = 65533), (i += s - 1);
      else {
        for (e &= 2 === s ? 31 : 3 === s ? 15 : 7; s > 1 && i < a; )
          (e = (e << 6) | (63 & t[i++])), s--;
        s > 1
          ? (r[n++] = 65533)
          : e < 65536
          ? (r[n++] = e)
          : ((e -= 65536),
            (r[n++] = 55296 | ((e >> 10) & 1023)),
            (r[n++] = 56320 | (1023 & e)));
      }
    }
    return ((t, e) => {
      if (e < 65534 && t.subarray && St)
        return String.fromCharCode.apply(
          null,
          t.length === e ? t : t.subarray(0, e)
        );
      let a = '';
      for (let i = 0; i < e; i++) a += String.fromCharCode(t[i]);
      return a;
    })(r, n);
  },
  jt = (t, e) => {
    (e = e || t.length) > t.length && (e = t.length);
    let a = e - 1;
    for (; a >= 0 && 128 == (192 & t[a]); ) a--;
    return a < 0 || 0 === a ? e : a + Kt[t[a]] > e ? a : e;
  };
var Nt = function () {
  (this.input = null),
    (this.next_in = 0),
    (this.avail_in = 0),
    (this.total_in = 0),
    (this.output = null),
    (this.next_out = 0),
    (this.avail_out = 0),
    (this.total_out = 0),
    (this.msg = ''),
    (this.state = null),
    (this.data_type = 2),
    (this.adler = 0);
};
var Jt = function (t, e) {
  let a, i, n, r, s, o, l, h, d, f, b, u, c, p, m, w, g, v, k, x, y, z, P, T;
  const X = t.state;
  (a = t.next_in),
    (P = t.input),
    (i = a + (t.avail_in - 5)),
    (n = t.next_out),
    (T = t.output),
    (r = n - (e - t.avail_out)),
    (s = n + (t.avail_out - 257)),
    (o = X.dmax),
    (l = X.wsize),
    (h = X.whave),
    (d = X.wnext),
    (f = X.window),
    (b = X.hold),
    (u = X.bits),
    (c = X.lencode),
    (p = X.distcode),
    (m = (1 << X.lenbits) - 1),
    (w = (1 << X.distbits) - 1);
  t: do {
    u < 15 && ((b += P[a++] << u), (u += 8), (b += P[a++] << u), (u += 8)),
      (g = c[b & m]);
    e: for (;;) {
      if (
        ((v = g >>> 24), (b >>>= v), (u -= v), (v = (g >>> 16) & 255), 0 === v)
      )
        T[n++] = 65535 & g;
      else {
        if (!(16 & v)) {
          if (0 == (64 & v)) {
            g = c[(65535 & g) + (b & ((1 << v) - 1))];
            continue e;
          }
          if (32 & v) {
            X.mode = 12;
            break t;
          }
          (t.msg = 'invalid literal/length code'), (X.mode = 30);
          break t;
        }
        (k = 65535 & g),
          (v &= 15),
          v &&
            (u < v && ((b += P[a++] << u), (u += 8)),
            (k += b & ((1 << v) - 1)),
            (b >>>= v),
            (u -= v)),
          u < 15 &&
            ((b += P[a++] << u), (u += 8), (b += P[a++] << u), (u += 8)),
          (g = p[b & w]);
        a: for (;;) {
          if (
            ((v = g >>> 24),
            (b >>>= v),
            (u -= v),
            (v = (g >>> 16) & 255),
            !(16 & v))
          ) {
            if (0 == (64 & v)) {
              g = p[(65535 & g) + (b & ((1 << v) - 1))];
              continue a;
            }
            (t.msg = 'invalid distance code'), (X.mode = 30);
            break t;
          }
          if (
            ((x = 65535 & g),
            (v &= 15),
            u < v &&
              ((b += P[a++] << u),
              (u += 8),
              u < v && ((b += P[a++] << u), (u += 8))),
            (x += b & ((1 << v) - 1)),
            x > o)
          ) {
            (t.msg = 'invalid distance too far back'), (X.mode = 30);
            break t;
          }
          if (((b >>>= v), (u -= v), (v = n - r), x > v)) {
            if (((v = x - v), v > h && X.sane)) {
              (t.msg = 'invalid distance too far back'), (X.mode = 30);
              break t;
            }
            if (((y = 0), (z = f), 0 === d)) {
              if (((y += l - v), v < k)) {
                k -= v;
                do {
                  T[n++] = f[y++];
                } while (--v);
                (y = n - x), (z = T);
              }
            } else if (d < v) {
              if (((y += l + d - v), (v -= d), v < k)) {
                k -= v;
                do {
                  T[n++] = f[y++];
                } while (--v);
                if (((y = 0), d < k)) {
                  (v = d), (k -= v);
                  do {
                    T[n++] = f[y++];
                  } while (--v);
                  (y = n - x), (z = T);
                }
              }
            } else if (((y += d - v), v < k)) {
              k -= v;
              do {
                T[n++] = f[y++];
              } while (--v);
              (y = n - x), (z = T);
            }
            for (; k > 2; )
              (T[n++] = z[y++]), (T[n++] = z[y++]), (T[n++] = z[y++]), (k -= 3);
            k && ((T[n++] = z[y++]), k > 1 && (T[n++] = z[y++]));
          } else {
            y = n - x;
            do {
              (T[n++] = T[y++]), (T[n++] = T[y++]), (T[n++] = T[y++]), (k -= 3);
            } while (k > 2);
            k && ((T[n++] = T[y++]), k > 1 && (T[n++] = T[y++]));
          }
          break;
        }
      }
      break;
    }
  } while (a < i && n < s);
  (k = u >> 3),
    (a -= k),
    (u -= k << 3),
    (b &= (1 << u) - 1),
    (t.next_in = a),
    (t.next_out = n),
    (t.avail_in = a < i ? i - a + 5 : 5 - (a - i)),
    (t.avail_out = n < s ? s - n + 257 : 257 - (n - s)),
    (X.hold = b),
    (X.bits = u);
};
const It = new Uint16Array([
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
    83, 99, 115, 131, 163, 195, 227, 258, 0, 0
  ]),
  Ct = new Uint8Array([
    16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19,
    19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78
  ]),
  Qt = new Uint16Array([
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
    769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0
  ]),
  _t = new Uint8Array([
    16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24,
    24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64
  ]);
var $t = (t, e, a, i, n, r, s, o) => {
  const l = o.bits;
  let h,
    d,
    f,
    b,
    u,
    c,
    p = 0,
    m = 0,
    w = 0,
    g = 0,
    v = 0,
    k = 0,
    x = 0,
    y = 0,
    z = 0,
    P = 0,
    T = null,
    X = 0;
  const q = new Uint16Array(16),
    U = new Uint16Array(16);
  let L,
    O,
    S,
    K = null,
    R = 0;
  for (p = 0; p <= 15; p++) q[p] = 0;
  for (m = 0; m < i; m++) q[e[a + m]]++;
  for (v = l, g = 15; g >= 1 && 0 === q[g]; g--);
  if ((v > g && (v = g), 0 === g))
    return (n[r++] = 20971520), (n[r++] = 20971520), (o.bits = 1), 0;
  for (w = 1; w < g && 0 === q[w]; w++);
  for (v < w && (v = w), y = 1, p = 1; p <= 15; p++)
    if (((y <<= 1), (y -= q[p]), y < 0)) return -1;
  if (y > 0 && (0 === t || 1 !== g)) return -1;
  for (U[1] = 0, p = 1; p < 15; p++) U[p + 1] = U[p] + q[p];
  for (m = 0; m < i; m++) 0 !== e[a + m] && (s[U[e[a + m]]++] = m);
  if (
    (0 === t
      ? ((T = K = s), (c = 19))
      : 1 === t
      ? ((T = It), (X -= 257), (K = Ct), (R -= 257), (c = 256))
      : ((T = Qt), (K = _t), (c = -1)),
    (P = 0),
    (m = 0),
    (p = w),
    (u = r),
    (k = v),
    (x = 0),
    (f = -1),
    (z = 1 << v),
    (b = z - 1),
    (1 === t && z > 852) || (2 === t && z > 592))
  )
    return 1;
  for (;;) {
    (L = p - x),
      s[m] < c
        ? ((O = 0), (S = s[m]))
        : s[m] > c
        ? ((O = K[R + s[m]]), (S = T[X + s[m]]))
        : ((O = 96), (S = 0)),
      (h = 1 << (p - x)),
      (d = 1 << k),
      (w = d);
    do {
      (d -= h), (n[u + (P >> x) + d] = (L << 24) | (O << 16) | S | 0);
    } while (0 !== d);
    for (h = 1 << (p - 1); P & h; ) h >>= 1;
    if ((0 !== h ? ((P &= h - 1), (P += h)) : (P = 0), m++, 0 == --q[p])) {
      if (p === g) break;
      p = e[a + s[m]];
    }
    if (p > v && (P & b) !== f) {
      for (
        0 === x && (x = v), u += w, k = p - x, y = 1 << k;
        k + x < g && ((y -= q[k + x]), !(y <= 0));

      )
        k++, (y <<= 1);
      if (((z += 1 << k), (1 === t && z > 852) || (2 === t && z > 592)))
        return 1;
      (f = P & b), (n[f] = (v << 24) | (k << 16) | (u - r) | 0);
    }
  }
  return (
    0 !== P && (n[u + P] = ((p - x) << 24) | (64 << 16) | 0), (o.bits = v), 0
  );
};
const {
    Z_FINISH: te,
    Z_BLOCK: ee,
    Z_TREES: ae,
    Z_OK: ie,
    Z_STREAM_END: ne,
    Z_NEED_DICT: re,
    Z_STREAM_ERROR: se,
    Z_DATA_ERROR: oe,
    Z_MEM_ERROR: le,
    Z_BUF_ERROR: he,
    Z_DEFLATED: de
  } = V,
  fe = (t) =>
    ((t >>> 24) & 255) +
    ((t >>> 8) & 65280) +
    ((65280 & t) << 8) +
    ((255 & t) << 24);
function be() {
  (this.mode = 0),
    (this.last = !1),
    (this.wrap = 0),
    (this.havedict = !1),
    (this.flags = 0),
    (this.dmax = 0),
    (this.check = 0),
    (this.total = 0),
    (this.head = null),
    (this.wbits = 0),
    (this.wsize = 0),
    (this.whave = 0),
    (this.wnext = 0),
    (this.window = null),
    (this.hold = 0),
    (this.bits = 0),
    (this.length = 0),
    (this.offset = 0),
    (this.extra = 0),
    (this.lencode = null),
    (this.distcode = null),
    (this.lenbits = 0),
    (this.distbits = 0),
    (this.ncode = 0),
    (this.nlen = 0),
    (this.ndist = 0),
    (this.have = 0),
    (this.next = null),
    (this.lens = new Uint16Array(320)),
    (this.work = new Uint16Array(288)),
    (this.lendyn = null),
    (this.distdyn = null),
    (this.sane = 0),
    (this.back = 0),
    (this.was = 0);
}
const ue = (t) => {
    if (!t || !t.state) return se;
    const e = t.state;
    return (
      (t.total_in = t.total_out = e.total = 0),
      (t.msg = ''),
      e.wrap && (t.adler = 1 & e.wrap),
      (e.mode = 1),
      (e.last = 0),
      (e.havedict = 0),
      (e.dmax = 32768),
      (e.head = null),
      (e.hold = 0),
      (e.bits = 0),
      (e.lencode = e.lendyn = new Int32Array(852)),
      (e.distcode = e.distdyn = new Int32Array(592)),
      (e.sane = 1),
      (e.back = -1),
      ie
    );
  },
  ce = (t) => {
    if (!t || !t.state) return se;
    const e = t.state;
    return (e.wsize = 0), (e.whave = 0), (e.wnext = 0), ue(t);
  },
  pe = (t, e) => {
    let a;
    if (!t || !t.state) return se;
    const i = t.state;
    return (
      e < 0 ? ((a = 0), (e = -e)) : ((a = 1 + (e >> 4)), e < 48 && (e &= 15)),
      e && (e < 8 || e > 15)
        ? se
        : (null !== i.window && i.wbits !== e && (i.window = null),
          (i.wrap = a),
          (i.wbits = e),
          ce(t))
    );
  },
  me = (t, e) => {
    if (!t) return se;
    const a = new be();
    (t.state = a), (a.window = null);
    const i = pe(t, e);
    return i !== ie && (t.state = null), i;
  };
let we,
  ge,
  ve = !0;
const ke = (t) => {
    if (ve) {
      (we = new Int32Array(512)), (ge = new Int32Array(32));
      let e = 0;
      for (; e < 144; ) t.lens[e++] = 8;
      for (; e < 256; ) t.lens[e++] = 9;
      for (; e < 280; ) t.lens[e++] = 7;
      for (; e < 288; ) t.lens[e++] = 8;
      for ($t(1, t.lens, 0, 288, we, 0, t.work, { bits: 9 }), e = 0; e < 32; )
        t.lens[e++] = 5;
      $t(2, t.lens, 0, 32, ge, 0, t.work, { bits: 5 }), (ve = !1);
    }
    (t.lencode = we), (t.lenbits = 9), (t.distcode = ge), (t.distbits = 5);
  },
  xe = (t, e, a, i) => {
    let n;
    const r = t.state;
    return (
      null === r.window &&
        ((r.wsize = 1 << r.wbits),
        (r.wnext = 0),
        (r.whave = 0),
        (r.window = new Uint8Array(r.wsize))),
      i >= r.wsize
        ? (r.window.set(e.subarray(a - r.wsize, a), 0),
          (r.wnext = 0),
          (r.whave = r.wsize))
        : ((n = r.wsize - r.wnext),
          n > i && (n = i),
          r.window.set(e.subarray(a - i, a - i + n), r.wnext),
          (i -= n)
            ? (r.window.set(e.subarray(a - i, a), 0),
              (r.wnext = i),
              (r.whave = r.wsize))
            : ((r.wnext += n),
              r.wnext === r.wsize && (r.wnext = 0),
              r.whave < r.wsize && (r.whave += n))),
      0
    );
  };
var ye = {
  inflateReset: ce,
  inflateReset2: pe,
  inflateResetKeep: ue,
  inflateInit: (t) => me(t, 15),
  inflateInit2: me,
  inflate: (t, e) => {
    let a,
      i,
      n,
      r,
      s,
      o,
      l,
      h,
      d,
      f,
      b,
      u,
      c,
      p,
      m,
      w,
      g,
      v,
      k,
      x,
      y,
      z,
      P = 0;
    const T = new Uint8Array(4);
    let X, q;
    const U = new Uint8Array([
      16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
    ]);
    if (!t || !t.state || !t.output || (!t.input && 0 !== t.avail_in))
      return se;
    (a = t.state),
      12 === a.mode && (a.mode = 13),
      (s = t.next_out),
      (n = t.output),
      (l = t.avail_out),
      (r = t.next_in),
      (i = t.input),
      (o = t.avail_in),
      (h = a.hold),
      (d = a.bits),
      (f = o),
      (b = l),
      (z = ie);
    t: for (;;)
      switch (a.mode) {
        case 1:
          if (0 === a.wrap) {
            a.mode = 13;
            break;
          }
          for (; d < 16; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if (2 & a.wrap && 35615 === h) {
            (a.check = 0),
              (T[0] = 255 & h),
              (T[1] = (h >>> 8) & 255),
              (a.check = N(a.check, T, 2, 0)),
              (h = 0),
              (d = 0),
              (a.mode = 2);
            break;
          }
          if (
            ((a.flags = 0),
            a.head && (a.head.done = !1),
            !(1 & a.wrap) || (((255 & h) << 8) + (h >> 8)) % 31)
          ) {
            (t.msg = 'incorrect header check'), (a.mode = 30);
            break;
          }
          if ((15 & h) !== de) {
            (t.msg = 'unknown compression method'), (a.mode = 30);
            break;
          }
          if (((h >>>= 4), (d -= 4), (y = 8 + (15 & h)), 0 === a.wbits))
            a.wbits = y;
          else if (y > a.wbits) {
            (t.msg = 'invalid window size'), (a.mode = 30);
            break;
          }
          (a.dmax = 1 << a.wbits),
            (t.adler = a.check = 1),
            (a.mode = 512 & h ? 10 : 12),
            (h = 0),
            (d = 0);
          break;
        case 2:
          for (; d < 16; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if (((a.flags = h), (255 & a.flags) !== de)) {
            (t.msg = 'unknown compression method'), (a.mode = 30);
            break;
          }
          if (57344 & a.flags) {
            (t.msg = 'unknown header flags set'), (a.mode = 30);
            break;
          }
          a.head && (a.head.text = (h >> 8) & 1),
            512 & a.flags &&
              ((T[0] = 255 & h),
              (T[1] = (h >>> 8) & 255),
              (a.check = N(a.check, T, 2, 0))),
            (h = 0),
            (d = 0),
            (a.mode = 3);
        case 3:
          for (; d < 32; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          a.head && (a.head.time = h),
            512 & a.flags &&
              ((T[0] = 255 & h),
              (T[1] = (h >>> 8) & 255),
              (T[2] = (h >>> 16) & 255),
              (T[3] = (h >>> 24) & 255),
              (a.check = N(a.check, T, 4, 0))),
            (h = 0),
            (d = 0),
            (a.mode = 4);
        case 4:
          for (; d < 16; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          a.head && ((a.head.xflags = 255 & h), (a.head.os = h >> 8)),
            512 & a.flags &&
              ((T[0] = 255 & h),
              (T[1] = (h >>> 8) & 255),
              (a.check = N(a.check, T, 2, 0))),
            (h = 0),
            (d = 0),
            (a.mode = 5);
        case 5:
          if (1024 & a.flags) {
            for (; d < 16; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (a.length = h),
              a.head && (a.head.extra_len = h),
              512 & a.flags &&
                ((T[0] = 255 & h),
                (T[1] = (h >>> 8) & 255),
                (a.check = N(a.check, T, 2, 0))),
              (h = 0),
              (d = 0);
          } else a.head && (a.head.extra = null);
          a.mode = 6;
        case 6:
          if (
            1024 & a.flags &&
            ((u = a.length),
            u > o && (u = o),
            u &&
              (a.head &&
                ((y = a.head.extra_len - a.length),
                a.head.extra ||
                  (a.head.extra = new Uint8Array(a.head.extra_len)),
                a.head.extra.set(i.subarray(r, r + u), y)),
              512 & a.flags && (a.check = N(a.check, i, u, r)),
              (o -= u),
              (r += u),
              (a.length -= u)),
            a.length)
          )
            break t;
          (a.length = 0), (a.mode = 7);
        case 7:
          if (2048 & a.flags) {
            if (0 === o) break t;
            u = 0;
            do {
              (y = i[r + u++]),
                a.head &&
                  y &&
                  a.length < 65536 &&
                  (a.head.name += String.fromCharCode(y));
            } while (y && u < o);
            if (
              (512 & a.flags && (a.check = N(a.check, i, u, r)),
              (o -= u),
              (r += u),
              y)
            )
              break t;
          } else a.head && (a.head.name = null);
          (a.length = 0), (a.mode = 8);
        case 8:
          if (4096 & a.flags) {
            if (0 === o) break t;
            u = 0;
            do {
              (y = i[r + u++]),
                a.head &&
                  y &&
                  a.length < 65536 &&
                  (a.head.comment += String.fromCharCode(y));
            } while (y && u < o);
            if (
              (512 & a.flags && (a.check = N(a.check, i, u, r)),
              (o -= u),
              (r += u),
              y)
            )
              break t;
          } else a.head && (a.head.comment = null);
          a.mode = 9;
        case 9:
          if (512 & a.flags) {
            for (; d < 16; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            if (h !== (65535 & a.check)) {
              (t.msg = 'header crc mismatch'), (a.mode = 30);
              break;
            }
            (h = 0), (d = 0);
          }
          a.head && ((a.head.hcrc = (a.flags >> 9) & 1), (a.head.done = !0)),
            (t.adler = a.check = 0),
            (a.mode = 12);
          break;
        case 10:
          for (; d < 32; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          (t.adler = a.check = fe(h)), (h = 0), (d = 0), (a.mode = 11);
        case 11:
          if (0 === a.havedict)
            return (
              (t.next_out = s),
              (t.avail_out = l),
              (t.next_in = r),
              (t.avail_in = o),
              (a.hold = h),
              (a.bits = d),
              re
            );
          (t.adler = a.check = 1), (a.mode = 12);
        case 12:
          if (e === ee || e === ae) break t;
        case 13:
          if (a.last) {
            (h >>>= 7 & d), (d -= 7 & d), (a.mode = 27);
            break;
          }
          for (; d < 3; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          switch (((a.last = 1 & h), (h >>>= 1), (d -= 1), 3 & h)) {
            case 0:
              a.mode = 14;
              break;
            case 1:
              if ((ke(a), (a.mode = 20), e === ae)) {
                (h >>>= 2), (d -= 2);
                break t;
              }
              break;
            case 2:
              a.mode = 17;
              break;
            case 3:
              (t.msg = 'invalid block type'), (a.mode = 30);
          }
          (h >>>= 2), (d -= 2);
          break;
        case 14:
          for (h >>>= 7 & d, d -= 7 & d; d < 32; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if ((65535 & h) != ((h >>> 16) ^ 65535)) {
            (t.msg = 'invalid stored block lengths'), (a.mode = 30);
            break;
          }
          if (
            ((a.length = 65535 & h), (h = 0), (d = 0), (a.mode = 15), e === ae)
          )
            break t;
        case 15:
          a.mode = 16;
        case 16:
          if (((u = a.length), u)) {
            if ((u > o && (u = o), u > l && (u = l), 0 === u)) break t;
            n.set(i.subarray(r, r + u), s),
              (o -= u),
              (r += u),
              (l -= u),
              (s += u),
              (a.length -= u);
            break;
          }
          a.mode = 12;
          break;
        case 17:
          for (; d < 14; ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if (
            ((a.nlen = 257 + (31 & h)),
            (h >>>= 5),
            (d -= 5),
            (a.ndist = 1 + (31 & h)),
            (h >>>= 5),
            (d -= 5),
            (a.ncode = 4 + (15 & h)),
            (h >>>= 4),
            (d -= 4),
            a.nlen > 286 || a.ndist > 30)
          ) {
            (t.msg = 'too many length or distance symbols'), (a.mode = 30);
            break;
          }
          (a.have = 0), (a.mode = 18);
        case 18:
          for (; a.have < a.ncode; ) {
            for (; d < 3; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (a.lens[U[a.have++]] = 7 & h), (h >>>= 3), (d -= 3);
          }
          for (; a.have < 19; ) a.lens[U[a.have++]] = 0;
          if (
            ((a.lencode = a.lendyn),
            (a.lenbits = 7),
            (X = { bits: a.lenbits }),
            (z = $t(0, a.lens, 0, 19, a.lencode, 0, a.work, X)),
            (a.lenbits = X.bits),
            z)
          ) {
            (t.msg = 'invalid code lengths set'), (a.mode = 30);
            break;
          }
          (a.have = 0), (a.mode = 19);
        case 19:
          for (; a.have < a.nlen + a.ndist; ) {
            for (
              ;
              (P = a.lencode[h & ((1 << a.lenbits) - 1)]),
                (m = P >>> 24),
                (w = (P >>> 16) & 255),
                (g = 65535 & P),
                !(m <= d);

            ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            if (g < 16) (h >>>= m), (d -= m), (a.lens[a.have++] = g);
            else {
              if (16 === g) {
                for (q = m + 2; d < q; ) {
                  if (0 === o) break t;
                  o--, (h += i[r++] << d), (d += 8);
                }
                if (((h >>>= m), (d -= m), 0 === a.have)) {
                  (t.msg = 'invalid bit length repeat'), (a.mode = 30);
                  break;
                }
                (y = a.lens[a.have - 1]),
                  (u = 3 + (3 & h)),
                  (h >>>= 2),
                  (d -= 2);
              } else if (17 === g) {
                for (q = m + 3; d < q; ) {
                  if (0 === o) break t;
                  o--, (h += i[r++] << d), (d += 8);
                }
                (h >>>= m),
                  (d -= m),
                  (y = 0),
                  (u = 3 + (7 & h)),
                  (h >>>= 3),
                  (d -= 3);
              } else {
                for (q = m + 7; d < q; ) {
                  if (0 === o) break t;
                  o--, (h += i[r++] << d), (d += 8);
                }
                (h >>>= m),
                  (d -= m),
                  (y = 0),
                  (u = 11 + (127 & h)),
                  (h >>>= 7),
                  (d -= 7);
              }
              if (a.have + u > a.nlen + a.ndist) {
                (t.msg = 'invalid bit length repeat'), (a.mode = 30);
                break;
              }
              for (; u--; ) a.lens[a.have++] = y;
            }
          }
          if (30 === a.mode) break;
          if (0 === a.lens[256]) {
            (t.msg = 'invalid code -- missing end-of-block'), (a.mode = 30);
            break;
          }
          if (
            ((a.lenbits = 9),
            (X = { bits: a.lenbits }),
            (z = $t(1, a.lens, 0, a.nlen, a.lencode, 0, a.work, X)),
            (a.lenbits = X.bits),
            z)
          ) {
            (t.msg = 'invalid literal/lengths set'), (a.mode = 30);
            break;
          }
          if (
            ((a.distbits = 6),
            (a.distcode = a.distdyn),
            (X = { bits: a.distbits }),
            (z = $t(2, a.lens, a.nlen, a.ndist, a.distcode, 0, a.work, X)),
            (a.distbits = X.bits),
            z)
          ) {
            (t.msg = 'invalid distances set'), (a.mode = 30);
            break;
          }
          if (((a.mode = 20), e === ae)) break t;
        case 20:
          a.mode = 21;
        case 21:
          if (o >= 6 && l >= 258) {
            (t.next_out = s),
              (t.avail_out = l),
              (t.next_in = r),
              (t.avail_in = o),
              (a.hold = h),
              (a.bits = d),
              Jt(t, b),
              (s = t.next_out),
              (n = t.output),
              (l = t.avail_out),
              (r = t.next_in),
              (i = t.input),
              (o = t.avail_in),
              (h = a.hold),
              (d = a.bits),
              12 === a.mode && (a.back = -1);
            break;
          }
          for (
            a.back = 0;
            (P = a.lencode[h & ((1 << a.lenbits) - 1)]),
              (m = P >>> 24),
              (w = (P >>> 16) & 255),
              (g = 65535 & P),
              !(m <= d);

          ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if (w && 0 == (240 & w)) {
            for (
              v = m, k = w, x = g;
              (P = a.lencode[x + ((h & ((1 << (v + k)) - 1)) >> v)]),
                (m = P >>> 24),
                (w = (P >>> 16) & 255),
                (g = 65535 & P),
                !(v + m <= d);

            ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (h >>>= v), (d -= v), (a.back += v);
          }
          if (((h >>>= m), (d -= m), (a.back += m), (a.length = g), 0 === w)) {
            a.mode = 26;
            break;
          }
          if (32 & w) {
            (a.back = -1), (a.mode = 12);
            break;
          }
          if (64 & w) {
            (t.msg = 'invalid literal/length code'), (a.mode = 30);
            break;
          }
          (a.extra = 15 & w), (a.mode = 22);
        case 22:
          if (a.extra) {
            for (q = a.extra; d < q; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (a.length += h & ((1 << a.extra) - 1)),
              (h >>>= a.extra),
              (d -= a.extra),
              (a.back += a.extra);
          }
          (a.was = a.length), (a.mode = 23);
        case 23:
          for (
            ;
            (P = a.distcode[h & ((1 << a.distbits) - 1)]),
              (m = P >>> 24),
              (w = (P >>> 16) & 255),
              (g = 65535 & P),
              !(m <= d);

          ) {
            if (0 === o) break t;
            o--, (h += i[r++] << d), (d += 8);
          }
          if (0 == (240 & w)) {
            for (
              v = m, k = w, x = g;
              (P = a.distcode[x + ((h & ((1 << (v + k)) - 1)) >> v)]),
                (m = P >>> 24),
                (w = (P >>> 16) & 255),
                (g = 65535 & P),
                !(v + m <= d);

            ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (h >>>= v), (d -= v), (a.back += v);
          }
          if (((h >>>= m), (d -= m), (a.back += m), 64 & w)) {
            (t.msg = 'invalid distance code'), (a.mode = 30);
            break;
          }
          (a.offset = g), (a.extra = 15 & w), (a.mode = 24);
        case 24:
          if (a.extra) {
            for (q = a.extra; d < q; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            (a.offset += h & ((1 << a.extra) - 1)),
              (h >>>= a.extra),
              (d -= a.extra),
              (a.back += a.extra);
          }
          if (a.offset > a.dmax) {
            (t.msg = 'invalid distance too far back'), (a.mode = 30);
            break;
          }
          a.mode = 25;
        case 25:
          if (0 === l) break t;
          if (((u = b - l), a.offset > u)) {
            if (((u = a.offset - u), u > a.whave && a.sane)) {
              (t.msg = 'invalid distance too far back'), (a.mode = 30);
              break;
            }
            u > a.wnext
              ? ((u -= a.wnext), (c = a.wsize - u))
              : (c = a.wnext - u),
              u > a.length && (u = a.length),
              (p = a.window);
          } else (p = n), (c = s - a.offset), (u = a.length);
          u > l && (u = l), (l -= u), (a.length -= u);
          do {
            n[s++] = p[c++];
          } while (--u);
          0 === a.length && (a.mode = 21);
          break;
        case 26:
          if (0 === l) break t;
          (n[s++] = a.length), l--, (a.mode = 21);
          break;
        case 27:
          if (a.wrap) {
            for (; d < 32; ) {
              if (0 === o) break t;
              o--, (h |= i[r++] << d), (d += 8);
            }
            if (
              ((b -= l),
              (t.total_out += b),
              (a.total += b),
              b &&
                (t.adler = a.check =
                  a.flags ? N(a.check, n, b, s - b) : A(a.check, n, b, s - b)),
              (b = l),
              (a.flags ? h : fe(h)) !== a.check)
            ) {
              (t.msg = 'incorrect data check'), (a.mode = 30);
              break;
            }
            (h = 0), (d = 0);
          }
          a.mode = 28;
        case 28:
          if (a.wrap && a.flags) {
            for (; d < 32; ) {
              if (0 === o) break t;
              o--, (h += i[r++] << d), (d += 8);
            }
            if (h !== (4294967295 & a.total)) {
              (t.msg = 'incorrect length check'), (a.mode = 30);
              break;
            }
            (h = 0), (d = 0);
          }
          a.mode = 29;
        case 29:
          z = ne;
          break t;
        case 30:
          z = oe;
          break t;
        case 31:
          return le;
        default:
          return se;
      }
    return (
      (t.next_out = s),
      (t.avail_out = l),
      (t.next_in = r),
      (t.avail_in = o),
      (a.hold = h),
      (a.bits = d),
      (a.wsize ||
        (b !== t.avail_out && a.mode < 30 && (a.mode < 27 || e !== te))) &&
        xe(t, t.output, t.next_out, b - t.avail_out),
      (f -= t.avail_in),
      (b -= t.avail_out),
      (t.total_in += f),
      (t.total_out += b),
      (a.total += b),
      a.wrap &&
        b &&
        (t.adler = a.check =
          a.flags
            ? N(a.check, n, b, t.next_out - b)
            : A(a.check, n, b, t.next_out - b)),
      (t.data_type =
        a.bits +
        (a.last ? 64 : 0) +
        (12 === a.mode ? 128 : 0) +
        (20 === a.mode || 15 === a.mode ? 256 : 0)),
      ((0 === f && 0 === b) || e === te) && z === ie && (z = he),
      z
    );
  },
  inflateEnd: (t) => {
    if (!t || !t.state) return se;
    let e = t.state;
    return e.window && (e.window = null), (t.state = null), ie;
  },
  inflateGetHeader: (t, e) => {
    if (!t || !t.state) return se;
    const a = t.state;
    return 0 == (2 & a.wrap) ? se : ((a.head = e), (e.done = !1), ie);
  },
  inflateSetDictionary: (t, e) => {
    const a = e.length;
    let i, n, r;
    return t && t.state
      ? ((i = t.state),
        0 !== i.wrap && 11 !== i.mode
          ? se
          : 11 === i.mode && ((n = 1), (n = A(n, e, a, 0)), n !== i.check)
          ? oe
          : ((r = xe(t, e, a, a)),
            r ? ((i.mode = 31), le) : ((i.havedict = 1), ie)))
      : se;
  },
  inflateInfo: 'pako inflate (from Nodeca project)'
};
var ze = function () {
  (this.text = 0),
    (this.time = 0),
    (this.xflags = 0),
    (this.os = 0),
    (this.extra = null),
    (this.extra_len = 0),
    (this.name = ''),
    (this.comment = ''),
    (this.hcrc = 0),
    (this.done = !1);
};
const Pe = Object.prototype.toString,
  {
    Z_NO_FLUSH: Te,
    Z_FINISH: Xe,
    Z_OK: qe,
    Z_STREAM_END: Ue,
    Z_NEED_DICT: Le,
    Z_STREAM_ERROR: Oe,
    Z_DATA_ERROR: Se,
    Z_MEM_ERROR: Ke
  } = V;
function Re(t) {
  this.options = Lt({ chunkSize: 65536, windowBits: 15, to: '' }, t || {});
  const e = this.options;
  e.raw &&
    e.windowBits >= 0 &&
    e.windowBits < 16 &&
    ((e.windowBits = -e.windowBits),
    0 === e.windowBits && (e.windowBits = -15)),
    !(e.windowBits >= 0 && e.windowBits < 16) ||
      (t && t.windowBits) ||
      (e.windowBits += 32),
    e.windowBits > 15 &&
      e.windowBits < 48 &&
      0 == (15 & e.windowBits) &&
      (e.windowBits |= 15),
    (this.err = 0),
    (this.msg = ''),
    (this.ended = !1),
    (this.chunks = []),
    (this.strm = new Nt()),
    (this.strm.avail_out = 0);
  let a = ye.inflateInit2(this.strm, e.windowBits);
  if (a !== qe) throw new Error(D[a]);
  if (
    ((this.header = new ze()),
    ye.inflateGetHeader(this.strm, this.header),
    e.dictionary &&
      ('string' == typeof e.dictionary
        ? (e.dictionary = Rt(e.dictionary))
        : '[object ArrayBuffer]' === Pe.call(e.dictionary) &&
          (e.dictionary = new Uint8Array(e.dictionary)),
      e.raw &&
        ((a = ye.inflateSetDictionary(this.strm, e.dictionary)), a !== qe)))
  )
    throw new Error(D[a]);
}
function Ae(t, e) {
  const a = new Re(e);
  if ((a.push(t), a.err)) throw a.msg || D[a.err];
  return a.result;
}
(Re.prototype.push = function (t, e) {
  const a = this.strm,
    i = this.options.chunkSize,
    n = this.options.dictionary;
  let r, s, o;
  if (this.ended) return !1;
  for (
    s = e === ~~e ? e : !0 === e ? Xe : Te,
      '[object ArrayBuffer]' === Pe.call(t)
        ? (a.input = new Uint8Array(t))
        : (a.input = t),
      a.next_in = 0,
      a.avail_in = a.input.length;
    ;

  ) {
    for (
      0 === a.avail_out &&
        ((a.output = new Uint8Array(i)), (a.next_out = 0), (a.avail_out = i)),
        r = ye.inflate(a, s),
        r === Le &&
          n &&
          ((r = ye.inflateSetDictionary(a, n)),
          r === qe ? (r = ye.inflate(a, s)) : r === Se && (r = Le));
      a.avail_in > 0 && r === Ue && a.state.wrap > 0 && 0 !== t[a.next_in];

    )
      ye.inflateReset(a), (r = ye.inflate(a, s));
    switch (r) {
      case Oe:
      case Se:
      case Le:
      case Ke:
        return this.onEnd(r), (this.ended = !0), !1;
    }
    if (((o = a.avail_out), a.next_out && (0 === a.avail_out || r === Ue)))
      if ('string' === this.options.to) {
        let t = jt(a.output, a.next_out),
          e = a.next_out - t,
          n = At(a.output, t);
        (a.next_out = e),
          (a.avail_out = i - e),
          e && a.output.set(a.output.subarray(t, t + e), 0),
          this.onData(n);
      } else
        this.onData(
          a.output.length === a.next_out
            ? a.output
            : a.output.subarray(0, a.next_out)
        );
    if (r !== qe || 0 !== o) {
      if (r === Ue)
        return (
          (r = ye.inflateEnd(this.strm)), this.onEnd(r), (this.ended = !0), !0
        );
      if (0 === a.avail_in) break;
    }
  }
  return !0;
}),
  (Re.prototype.onData = function (t) {
    this.chunks.push(t);
  }),
  (Re.prototype.onEnd = function (t) {
    t === qe &&
      ('string' === this.options.to
        ? (this.result = this.chunks.join(''))
        : (this.result = Ot(this.chunks))),
      (this.chunks = []),
      (this.err = t),
      (this.msg = this.strm.msg);
  });
var je = {
  Inflate: Re,
  inflate: Ae,
  inflateRaw: function (t, e) {
    return ((e = e || {}).raw = !0), Ae(t, e);
  },
  ungzip: Ae,
  constants: V
};
const { Inflate: Ne, inflate: De, inflateRaw: Ve, ungzip: Ge } = je;
var Ze = De;
const Me = URL.createObjectURL(
    new Blob(
      [
        Ze(
          Uint8Array.from(
            atob(
              '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'
            ),
            (t) => t.charCodeAt(0)
          ),
          { to: 'string' }
        )
      ],
      { type: 'text/javascript' }
    )
  ),
  Ee = Ze(
    Uint8Array.from(
      atob(
        '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'
      ),
      (t) => t.charCodeAt(0)
    )
  ).buffer,
  Be = function (t, e) {
    if (!new.target) return Object.freeze(new Be(t, e));
    Object.keys(e).forEach((t) => {
      this[t] = e[t];
    });
    const a = [],
      i = (e, i = {}) =>
        new Promise((n, r) => {
          (e.cb = i.each),
            a.push({ resolve: n, reject: r, cb: i.call }),
            t.postMessage(e);
        });
    (t.onmessage = (t) => {
      const { cb: e, res: i } = t.data;
      e ? a[0].cb(e) : a.shift().resolve(i);
    }),
      (t.onerror = (t) => {
        t.preventDefault(), a.shift().reject(t);
      }),
      (this.solve = (t, e) => {
        const a = {
          ...('number' == typeof (e = e || t.options || {})
            ? { msglev: e }
            : e),
          cb: null
        };
        return e.cb && e.cb.call && 'function' == typeof e.cb.call
          ? i({ cmd: 'solve', lp: t, opt: a }, e.cb)
          : i({ cmd: 'solve', lp: t, opt: a });
      }),
      (this.write = (t) => i({ cmd: 'write', lp: t })),
      (this.terminate = () => t.terminate());
  },
  He = () =>
    new Promise((t, e) => {
      const a = new Worker(Me);
      (a.onmessage = (e) => {
        t([a, e.data]);
      }),
        (a.onerror = (t) => {
          e(t.message);
        }),
        a.postMessage({ wasmBinary: Ee });
    }).then((t) => Be(...t));

class MILP {
  /**
   * Create a mixed-integer linear programming model
   * @param {object} cfDirection Integer +1 if 0 => 1, -1 if 1 => 0 (classification),
   * +1 if we need to increase the prediction, -1 if decrease (regression).
   * @param {Array<Array<object>>} neededScoreGain The score gain needed to
   * achieve the CF goal.
   * @param {object} featuresToVary Feature names of features that the
   * generated CF can change.
   * @param {object} options Possible options for each variable. Each option is
   * a list [target, score_gain, distance, bin_index].
   * @param {object} maxNumFeaturesToVary Max number of features that the
   * generated CF can change. If the value is None, the CFs can change any
   * number of features.
   * @param {Array<string>} mutedVariables Variables that this MILP should not
   * use. This is useful to mute optimal variables so we can explore diverse
   * solutions. This list should not include interaction variables.
   * @param {number} verbose Verbose level: 0, 1, 2
   */
  constructor(
    cfDirection,
    neededScoreGain,
    featuresToVary,
    options,
    maxNumFeaturesToVary = null,
    mutedVariables = [],
    verbose = 0
  ) {
    // Init attributes
    this.cfDirection = cfDirection;
    this.neededScoreGain = neededScoreGain;
    this.featuresToVary = featuresToVary;
    this.options = options;
    this.maxNumFeaturesToVary = maxNumFeaturesToVary;
    this.mutedVariables = new Set(mutedVariables);
    this.verbose = verbose;
  }

  async initGLPK() {
    this.glpk = await He();

    // Arguments for the GLPK solver
    this.modelOptions = {
      msglev: this.glpk.GLP_MSG_ERR
    };

    if (this.verbose === 2) {
      this.modelOptions.msglev = this.glpk.GLP_MSG_ALL;
    }

    // Create the MILP model
    this.model = null;
    this.variables = null;
    this.createMILP();
  }

  /**
   * Create an MILP model through a JSON format to interact with a GLPK solver.
   */
  createMILP() {
    // JSON object for the model
    let model = {
      name: 'ebmCounterfactual',
      subjectTo: [],
      binaries: [],
      bounds: []
    };

    // CF constraint
    let cfConstraint = {
      name: 'cf-constraint',
      vars: []
    };

    // Different constraint bounds for different CF directions
    if (this.cfDirection === 1) {
      cfConstraint.bnds = { type: this.glpk.GLP_LO, lb: this.neededScoreGain };
    } else {
      cfConstraint.bnds = { type: this.glpk.GLP_UP, ub: this.neededScoreGain };
    }

    // Objective function (minimizing the distance function)
    let objective = {
      direction: this.glpk.GLP_MIN,
      name: 'obj',
      vars: []
    };

    // Collect all variables
    let variables = {};

    // Iterate through all the main effect features
    this.featuresToVary.forEach((f) => {
      let curVariables = [];
      // There is at most one active variable for one feature
      let curBoundConstraint = {
        name: `bound-cons-${f}`,
        vars: [],
        bnds: { type: this.glpk.GLP_UP, ub: 1.0 }
      };

      this.options[f].forEach((option) => {
        // Variable has name '{feature name}:{bin id}'
        let varName = `${f}:${option[3]}`;

        // Only proceed on variables that are not muted
        if (!this.mutedVariables.has(varName)) {
          // Collect this variable
          curVariables.push(varName);
          model.binaries.push(varName);

          // Add to the feature-level constraint
          curBoundConstraint.vars.push({ name: varName, coef: 1.0 });

          // Add to the model-level CF constraint
          cfConstraint.vars.push({ name: varName, coef: option[1] });

          // Add to the model-level distance objective
          objective.vars.push({ name: varName, coef: option[2] });
        }
      });

      variables[f] = curVariables;

      // Register the feature-level constraint
      model.subjectTo.push(curBoundConstraint);
    });

    // Users can also set `max_num_features_to_vary` to control the total
    // number of features to vary
    if (this.maxNumFeaturesToVary !== null) {
      let maxNumConstraint = {
        name: 'max-num-cons',
        vars: [],
        bnds: { type: this.glpk.GLP_UP, ub: this.maxNumFeaturesToVary }
      };

      Object.keys(variables).forEach((f) => {
        variables[f].forEach((varName) => {
          maxNumConstraint.vars.push({ name: varName, coef: 1.0 });
        });
      });

      model.subjectTo.push(maxNumConstraint);
    }

    // Create variables for interaction effects
    Object.keys(this.options).forEach((optName) => {
      if (optName.includes(' x ')) {
        // console.log(optName);
        let f1Name = optName.replace(/(.+)\sx\s.+/, '$1');
        let f2Name = optName.replace(/.+\sx\s(.+)/, '$1');

        if (
          this.featuresToVary.includes(f1Name) &&
          this.featuresToVary.includes(f2Name)
        ) {
          let curVariables = [];

          // We need to include this interaction term, iterate through all possible options
          this.options[optName].forEach((option) => {
            // Recover the main effect variables
            let zName = `${optName}:${option[3][0]},${option[3][1]}`;

            // Only consider these two options if either of them is muted
            let xF1Name = `${f1Name}:${option[3][0]}`;
            let xF2Name = `${f2Name}:${option[3][1]}`;

            if (
              !this.mutedVariables.has(xF1Name) &&
              !this.mutedVariables.has(xF2Name)
            ) {
              console.assert(model.binaries.includes(xF2Name));
              console.assert(model.binaries.includes(xF1Name));

              // The interaction variable is the product of two binary main effect
              // variables
              // It can be linearized to three linear constraints

              // z <= x1
              model.subjectTo.push({
                name: `${zName}-1`,
                vars: [
                  { name: zName, coef: 1.0 },
                  { name: xF1Name, coef: -1.0 }
                ],
                bnds: { type: this.glpk.GLP_UP, ub: 0.0 }
              });

              // z <= x2
              model.subjectTo.push({
                name: `${zName}-2`,
                vars: [
                  { name: zName, coef: 1.0 },
                  { name: xF2Name, coef: -1.0 }
                ],
                bnds: { type: this.glpk.GLP_UP, ub: 0.0 }
              });

              // z >= x1 + x2 - 1
              // x1 + x2 - z <= 1
              model.subjectTo.push({
                name: `${zName}-3`,
                vars: [
                  { name: xF1Name, coef: 1.0 },
                  { name: xF2Name, coef: 1.0 },
                  { name: zName, coef: -1.0 }
                ],
                bnds: { type: this.glpk.GLP_UP, ub: 1.0 }
              });

              // z can be a continuous variable (easier to solve), bounded in 0 an 1
              model.bounds.push({
                name: zName,
                type: this.glpk.GLP_DB,
                lb: 0.0,
                ub: 1.0
              });

              // Add to the model-level CF constraint
              cfConstraint.vars.push({ name: zName, coef: option[1] });

              curVariables.push(zName);
            }
          });

          variables[optName] = curVariables;
        }
      }
    });

    // Register the model-level CF constraint and objective
    model.subjectTo.push(cfConstraint);
    model.objective = objective;

    this.variables = variables;
    this.model = model;
  }

  /**
   * Solve the MILP model
   */
  async solveMILP() {
    if (this.model !== null) {
      const result = await this.glpk.solve(this.model, this.modelOptions);

      // Identify active variable
      let activeVariables = [];

      if (result.result.status === this.glpk.GLP_OPT) {
        if (this.verbose > 0) {
          console.log(`Found optimal solution in ${result.time}s.`);
        }

        Object.keys(result.result.vars).forEach((varName) => {
          if (result.result.vars[varName] === 1) {
            activeVariables.push(varName);
          }
        });

        return [activeVariables, result.result.z];
      } else {
        console.log(`Fail to find solution with code ${result.result.status}`);
        return null;
      }
    }
    return null;
  }
}

/* eslint-disable lines-around-comment */

/**
 * Main class to generate counterfactual explanations for GAMs
 */
class GAMCoach {
  /**
   * Create a GAM Coach object
   * @param {object} ebmModel Trained ebm object in JSON format
   * @param {object} contMads MAD distances for continuous variables (optional)
   * @param {object} catDistances Distances for categorical variables (optional)
   */
  constructor(ebmModel, contMads = null, catDistances = null) {
    this.contMads = contMads;
    this.catDistances = catDistances;

    // Save the ebmModel so we can create ebmLocal later
    this.ebmModel = ebmModel;
    this.ebm = null;

    // Initialize the distances for continuous and categorical features
    this.contMads = contMads;
    this.catDistances = catDistances;

    if (this.contMads === null) {
      this.contMads = ebmModel.contMads;
    }

    if (this.catDistances === null) {
      this.catDistances = ebmModel.catDistances;
    }
  }

  /**
   * Generate counterfactual explanations.
   * Check out GAM Coach documentation page for detailed documentations
   * @param {object} config
   * @param {object[][]} config.curExample Point of interest (2D array, (1, k))
   * @param {number} [config.totalCfs] Number of CFs to generate
   * @param {number[]} [config.targetRange] Target range for regression problems
   * @param {number} [config.simThresholdFactor] The similarity threshold factor
   * for continuous features
   * @param {number} [config.simThreshold] The similarity threshold for cont
   *  features
   * @param {string | number} [config.categoricalWeight] Weight to scale cat
   *  features
   * @param {string[]} [config.featuresToVary] Names of features that can be
   *  changed
   * @param {number} [config.maxNumFeaturesToVary] Max number of features that
   *  a CF can change
   * @param {object} [config.featureRanges] The allowed range for different
   *  features
   * @param {object} [config.featureWeightMultipliers] The numbers that are
   *  multiplied to each feature's final computed distances. By default, the
   *  number is 1 for all features
   * @param {string[]} [config.continuousIntegerFeatures] Name of cont features
   * that should have integer values
   * @param {number} [config.verbose] 0, 1, 2, controlling the logging details
   */
  async generateCfs({
    curExample,
    totalCfs = 1,
    targetRange = null,
    simThresholdFactor = 0.005,
    simThreshold = null,
    categoricalWeight = 'auto',
    featuresToVary = null,
    maxNumFeaturesToVary = null,
    featureRanges = null,
    featureWeightMultipliers = null,
    continuousIntegerFeatures = null,
    verbose = 0
  }) {
    // Generate an EBMLocal object fixing on the current example
    this.ebm = new EBMLocal(this.ebmModel, curExample[0]);

    // Default to use all features
    // ?: if I'm using every features every time am I going to get
    // always the same results? Or there is some condition later, to at least
    // exclude possible ranges of features?
    if (featuresToVary === null) {
      featuresToVary = this.ebm.featureNames.filter((d, i) => {
        return this.ebm.featureTypes[i] !== 'interaction';
      });
    }

    // Step 1: Identify CF direction and score needed to gain
    let totalScore = this.ebm.predScore;
    let cfDirection = null;
    let neededScoreGain = null;
    let scoreGainBound = null;

    // Binary classification
    // Predicted 0 => +1
    // Predicted 1 => -1
    if (this.ebm.isClassifier) {
      cfDirection = this.ebm.pred * -2 + 1;
      neededScoreGain = -1 * totalScore;
    } else {
      // Regression
      // Increase => +1
      // Decrease => -1
      if (targetRange === null) {
        throw Error(
          'targetRange cannot be null when the model is a regressor.'
        );
      }

      if (totalScore >= targetRange[0] && totalScore <= targetRange[1]) {
        throw Error('The targetRange cannot cover the current prediction.');
      }

      if (totalScore < targetRange[0]) {
        cfDirection = 1;
        neededScoreGain = targetRange[0] - totalScore;
        scoreGainBound = targetRange[1] - totalScore;
      } else {
        cfDirection = -1;
        neededScoreGain = targetRange[1] - totalScore;
        scoreGainBound = targetRange[0] - totalScore;
      }
    }

    // console.log(cfDirection, neededScoreGain, scoreGainBound);

    // Step 2: Generate continuous, categorical, and interaction options
    let options = {};

    // Step 2.0: First generate a similarity threshold if it is not provided. The similarity
    // threshold is used to filter out redundant options
    if (simThreshold === null) {
      let additiveRanges = [];

      // We compute the average ranges across all continuous features
      for (let i = 0; i < this.ebm.featureNames.length; i++) {
        if (this.ebm.featureTypes[i] === 'continuous') {
          let curScores = this.ebm.scores[i];

          // Count the max and min score for each score array
          let maxScore = curScores.reduce((a, b) => Math.max(a, b));
          let minScore = curScores.reduce((a, b) => Math.min(a, b));
          additiveRanges.push(maxScore - minScore);
        }
      }

      simThreshold =
        additiveRanges.reduce((a, b) => a + b) / additiveRanges.length;
      simThreshold *= simThresholdFactor;
    }

    // Step 2.1: Find all good options from continuous and categorical features
    for (let i = 0; i < this.ebm.featureNames.length; i++) {
      let curFeatureName = this.ebm.featureNames[i];
      let curFeatureType = this.ebm.featureTypes[i];
      let curFeatureScore = this.ebm.countedScores[curFeatureName];
      let curFeatureValue = curExample[0][i];

      // Skip interaction terms
      if (curFeatureType === 'continuous') {
        // Check if this cont feature requires integer values
        let needToBeInt = false;
        if (
          continuousIntegerFeatures !== null &&
          continuousIntegerFeatures.includes(curFeatureName)
        ) {
          needToBeInt = true;
        }

        // Generate options for this continuous feature
        let contOptions = this.generateContOptions(
          cfDirection,
          i,
          curFeatureName,
          curFeatureValue,
          curFeatureScore,
          this.contMads,
          curExample[0],
          scoreGainBound,
          simThreshold,
          needToBeInt,
          true
        );
        options[curFeatureName] = contOptions;
      } else if (curFeatureType === 'categorical') {
        let catOptions = this.generateCatOptions(
          cfDirection,
          i,
          curFeatureValue,
          curFeatureScore,
          this.catDistances[curFeatureName],
          curExample[0],
          scoreGainBound,
          true
        );

        options[curFeatureName] = catOptions;
      }
    }

    // Step 2.2: Filter out undesirable options (based on the featureRange)
    if (featureRanges !== null) {
      Object.keys(featureRanges).forEach((name) => {
        let curRange = featureRanges[name];
        let curType =
          this.ebm.featureTypes[this.ebm.featureNames.indexOf(name)];

        if (curType === 'continuous') {
          // Remove options that use out-of-range features
          for (let o = options[name].length - 1; o >= 0; o--) {
            let curTarget = options[name][o][0];
            if (curTarget < curRange[0] || curTarget > curRange[1]) {
              options[name].splice(o, 1);
            }
          }
        } else if (curType === 'categorical') {
          for (let o = options[name].length - 1; o >= 0; o--) {
            let curTarget = options[name][o][0];
            if (!curRange.includes(curTarget)) {
              options[name].splice(o, 1);
            }
          }
        }
      });
    }

    // Step 2.3: Find all interaction offsets
    for (let i = 0; i < this.ebm.interactionIndexes.length; i++) {
      let curInteractionId = i;
      let curIndexes = this.ebm.interactionIndexes[i];
      let name1 = this.ebm.featureNames[curIndexes[0]];
      let name2 = this.ebm.featureNames[curIndexes[1]];
      let interName = `${name1} x ${name2}`;
      let curFeatureScore = this.ebm.countedScores[interName];

      options[interName] = this.generateInterOptions(
        curInteractionId,
        curIndexes[0],
        curIndexes[1],
        curFeatureScore,
        options
      );
    }

    // Step 2.4: Rescale the categorical distances so that they have the same
    // mean score as continuous variables (default way to scale it)
    if (categoricalWeight === 'auto') {
      // Count the current average scores for cont and cat features
      let contDistances = [];
      let catDistances = [];

      Object.keys(options).forEach((name) => {
        let curType =
          this.ebm.featureTypes[this.ebm.featureNames.indexOf(name)];

        if (curType === 'continuous') {
          options[name].forEach((option) => {
            contDistances.push(option[2]);
          });
        } else if (curType === 'categorical') {
          options[name].forEach((option) => {
            catDistances.push(option[2]);
          });
        }
      });

      if (contDistances.length !== 0 && catDistances.length !== 0) {
        let contMean =
          contDistances.reduce((a, b) => a + b) / contDistances.length;
        let catMean =
          catDistances.reduce((a, b) => a + b) / catDistances.length;
        categoricalWeight = contMean / catMean;
      } else {
        categoricalWeight = 1.0;
      }
    }

    // Rescaling categorical options
    Object.keys(options).forEach((name) => {
      let curType = this.ebm.featureTypes[this.ebm.featureNames.indexOf(name)];

      if (curType === 'categorical') {
        for (let i = 0; i < options[name].length; i++) {
          options[name][i][2] *= categoricalWeight;
        }
      }
    });

    // Step 2.5: Apply the final weight rescaling for selected features. This
    // step provides developers/users an interface to artificially modify the
    // distance weight of any features.
    if (featureWeightMultipliers !== null) {
      Object.keys(featureWeightMultipliers).forEach((name) => {
        const curMultiplier = featureWeightMultipliers[name];

        // Multiply the feature distance by the multiplier
        for (let i = 0; i < options[name].length; i++) {
          options[name][i][2] *= curMultiplier;
        }
      });
    }

    // Step 3: Formulate an MILP model and solve it
    // Here we generate diverse solutions by accumulatively muting optimal solutions
    let solutions = [];
    let mutedVariables = [];
    let isSuccessful = true;

    for (let i = 0; i < totalCfs; i++) {
      let milp = new MILP(
        cfDirection,
        neededScoreGain,
        featuresToVary,
        options,
        maxNumFeaturesToVary,
        mutedVariables,
        verbose
      );

      await milp.initGLPK();
      let solution = await milp.solveMILP();

      if (solution === null) {
        isSuccessful = false;
        console.log('Failed to generate all CFs.');
        break;
      }

      solutions.push(solution);
      solution[0].forEach((v) => {
        mutedVariables.push(v);
      });

      milp = null;
    }

    // Step 4: Convert the solutions into formatted CFs
    let cfs = this.convertCfToData(options, solutions, isSuccessful);

    cfs.nextCfConfig = {
      cfDirection,
      neededScoreGain,
      featuresToVary,
      options,
      maxNumFeaturesToVary,
      mutedVariables,
      verbose
    };

    return cfs;
  }

  /**
   * Generate the next-optimal CF solutions. This function should be called
   * after the top-k CFs are generated by generateCfs(), as it requires the
   * `options` argument (generated from generateCfs())
   * @param {object} config
   * @param {number} config.cfDirection
   * @param {number} config.neededScoreGain
   * @param {string[]} config.featuresToVary
   * @param {object} config.options
   * @param {number} config.maxNumFeaturesToVary
   * @param {string[]} config.mutedVariables
   * @param {number} config.verbose
   */
  async generateSubCfs({
    cfDirection,
    neededScoreGain,
    featuresToVary,
    options,
    maxNumFeaturesToVary,
    mutedVariables,
    verbose
  }) {
    let milp = new MILP(
      cfDirection,
      neededScoreGain,
      featuresToVary,
      options,
      maxNumFeaturesToVary,
      mutedVariables,
      verbose
    );

    await milp.initGLPK();
    let solution = await milp.solveMILP();

    let isSuccessful = true;
    let solutions;

    if (solution === null) {
      isSuccessful = false;
      solutions = [];
      console.log('Failed to generate all CFs.');
    } else {
      solution[0].forEach((v) => {
        mutedVariables.push(v);
      });
      solutions = [solution];
    }

    milp = null;

    // Step 4: Convert the solutions into formatted CFs
    let cfs = this.convertCfToData(options, solutions, isSuccessful);

    cfs.nextCfConfig = {
      cfDirection,
      neededScoreGain,
      featuresToVary,
      options,
      maxNumFeaturesToVary,
      mutedVariables,
      verbose
    };

    return cfs;
  }

  /**
   * Generate all alternative options for this continuous variable. You can read
   * the GAM Coach documentation page for more details.
   * @param {number} cfDirection The direction of the CF
   * @param {number} curFeatureIndex Index of the current features
   * @param {string} curFeatureName Name of the current features
   * @param {number} curFeatureValue Value of the current features
   * @param {number} curFeatureScore Corresponding score for the value
   * @param {number} contMads MAD score for the current features
   * @param {object[]} curExample The current sample values
   * @param {number} scoreGainBound The bound for the score gain
   * @param {number} epsilon Similarity threshold
   * @param {boolean} needToBeInt True if this variable should have integer values
   * @param {boolean} skipUnhelpfulMainOption True if to skip options from main
   *  effects that give opposite score gain. It is rare that there is a positive
   *  score gain from pair-interaction that outweigh negative score gain from
   *  two main effects, and adjusting the distance penalty.
   */
  generateContOptions(
    cfDirection,
    curFeatureIndex,
    curFeatureName,
    curFeatureValue,
    curFeatureScore,
    contMads,
    curExample,
    scoreGainBound = null,
    epsilon = 0.005,
    needToBeInt = false,
    skipUnhelpfulMainOption = true
  ) {
    // Get the additive scores and bin edges of this features
    let additives = this.ebm.scores[curFeatureIndex];
    let binStarts = this.ebm.binEdges[curFeatureIndex];

    let contOptions = [];

    // Identify which bin this value falls into
    let curBinId = searchSortedLowerIndex(binStarts, curFeatureValue);
    console.assert(additives[curBinId] === curFeatureScore);

    // Identify interaction terms that we need to consider
    let associatedInteractions = [];

    this.ebm.interactionIndexes.forEach((indexes, curInteractionId) => {
      if (indexes.includes(curFeatureIndex)) {
        const featurePosition = indexes[0] === curFeatureIndex ? 0 : 1;

        // Need to query which bin is used for the other feature
        const otherPosition = 1 - featurePosition;
        const otherIndex = indexes[otherPosition];

        // Get sub-types for this other feature term
        const otherType = this.ebm.featureTypes[otherIndex];
        const otherName = this.ebm.featureNames[otherIndex];

        // Get the current additive scores and bin edges
        let interactionAdditives = this.ebm.interactionScores[curInteractionId];
        let interactionBinEdges =
          this.ebm.interactionBinEdges[curInteractionId];

        // Get the current score on this interaction term
        let otherBin = -1;
        if (otherType === 'continuous') {
          otherBin = searchSortedLowerIndex(
            interactionBinEdges[otherPosition],
            curExample[otherIndex]
          );
        } else {
          // Need to encode the categorical level first
          let otherLevel = parseInt(
            this.ebm.labelEncoder[otherName][curExample[otherIndex]],
            10
          );
          otherBin = interactionBinEdges[otherPosition].indexOf(otherLevel);
        }

        const featureBin = searchSortedLowerIndex(
          interactionBinEdges[featurePosition],
          curFeatureValue
        );

        let featureInterScore = 0;
        if (featurePosition === 0) {
          featureInterScore = interactionAdditives[featureBin][otherBin];
        } else {
          featureInterScore = interactionAdditives[otherBin][featureBin];
        }

        // Extract the row or column where we fix the other feature and vary the
        // current feature
        let featureInterBinEdges = interactionBinEdges[featurePosition];
        const featureInterAdditives = [];

        if (featurePosition === 0) {
          for (let i = 0; i < interactionAdditives.length; i++) {
            featureInterAdditives.push(interactionAdditives[i][otherBin]);
          }
        } else {
          for (let i = 0; i < interactionAdditives[0].length; i++) {
            featureInterAdditives.push(interactionAdditives[otherBin][i]);
          }
        }

        // Register this interaction term
        associatedInteractions.push({
          interIndex: indexes,
          curInteractionId,
          featureInterScore,
          featureInterBinEdges,
          featureInterAdditives
        });
      }
    });

    // Iterate all bins to collect useful ones
    for (let i = 0; i < additives.length; i++) {
      // Because of the special binning structure of EBM, the distance of
      // bins on the left to the current value is different from the bins
      // that are on the right
      //
      // For bins on the left, the raw distance is abs(bin_start[i + 1] - x)
      // For bins on the right, the raw distance is abs(bin_start[i] - x)
      let target = curFeatureValue;
      let distance = 0;

      // Bins on the left
      if (i < curBinId) {
        // First check if it needs to be an integer, and if so we need to find
        // the closest integer to the right point
        if (needToBeInt) {
          target = Math.floor(binStarts[i + 1]);
          if (target === binStarts[i + 1]) {
            target -= 1;
          }

          // Skip this option if it is out of bin
          if (target < binStarts[i]) {
            continue;
          }

          distance = Math.abs(target - curFeatureValue);
        } else {
          // Does not need to be an integer
          target = binStarts[i + 1];
          distance = Math.abs(target - curFeatureValue);

          // Subtract a very small value to make the target technically fall
          // into the left bin
          target -= 1e-4;
        }
      } else if (i > curBinId) {
        // Bins on the right
        // First check if it needs to be an integer, if so it would be the closest
        // integer to the left point
        if (needToBeInt) {
          target = Math.ceil(binStarts[i]);
          if (target === binStarts[i]) {
            target += 1;
          }

          // Skip this option if it is out of bin
          if (i + 1 < additives.length && target >= binStarts[i + 1]) {
            continue;
          }

          distance = Math.abs(target - curFeatureValue);
        } else {
          // No need to be an integer value
          target = binStarts[i];
          distance = Math.abs(target - curFeatureValue);
        }
      }

      // Scale the distance based on the deviation of the feature on the training
      // data
      if (contMads[curFeatureName] > 0) {
        distance /= contMads[curFeatureName];
      }

      /**
       * Compute score gain which has two parts:
       * (1) gain from the change of main effect
       * (2) gain from the change of interaction effect
       */

      // Main effect
      const mainScoreGain = additives[i] - curFeatureScore;

      // Interaction terms
      let interScoreGain = 0;

      // A list to track all interaction score gain offsets
      // [[interaction id, interaction score gain]]
      let interScoreGains = [];

      associatedInteractions.forEach((d) => {
        const interBinId = searchSortedLowerIndex(
          d.featureInterBinEdges,
          target
        );

        interScoreGain +=
          d.featureInterAdditives[interBinId] - d.featureInterScore;
        interScoreGains.push([
          d.curInteractionId,
          d.featureInterAdditives[interBinId] - d.featureInterScore
        ]);
      });

      const scoreGain = mainScoreGain + interScoreGain;

      if (skipUnhelpfulMainOption && cfDirection * scoreGain <= 0) {
        continue;
      }

      // Remove out-of-bound bins
      if (scoreGainBound !== null && skipUnhelpfulMainOption) {
        if (cfDirection === 1 && scoreGain > scoreGainBound) {
          continue;
        } else if (cfDirection === -1 && scoreGain < scoreGainBound) {
          continue;
        }
      }

      // Collect this option
      contOptions.push([target, scoreGain, distance, i, interScoreGains]);
    }

    // Now we can apply the second round of filtering to remove redundant options
    // Redundant options refer to bins that give a similar score gain but require
    // larger distance
    contOptions = contOptions.sort((a, b) => a[2] - b[2]);

    let start = 0;
    while (start < contOptions.length) {
      for (let i = contOptions.length - 1; i > start; i--) {
        if (Math.abs(contOptions[i][1] - contOptions[start][1]) < epsilon) {
          contOptions.splice(i, 1);
        }
      }
      start++;
    }

    return contOptions;
  }

  /**
   * Generate options for categorical features. You can check out the GAM Coach
   * documentation for more details.
   * @param {number} cfDirection The direction of the CF
   * @param {number} curFeatureIndex The index of the current features
   * @param {string} curFeatureValue The level of the current categorical feature
   * @param {number} curFeatureScore The current score for this feature
   * @param {number} curCatDistance The distances for all levels in this feature
   * @param {object[]} curExample The current sample values
   * @param {number} scoreGainBound The bound for the score gain
   * @param {boolean} skipUnhelpfulMainOption True if to skip options from main
   *  effects that give opposite score gain. It is rare that there is a positive
   *  score gain from pair-interaction that outweigh negative score gain from
   *  two main effects, and adjusting the distance penalty.
   */
  generateCatOptions(
    cfDirection,
    curFeatureIndex,
    curFeatureValue,
    curFeatureScore,
    curCatDistance,
    curExample,
    scoreGainBound = null,
    skipUnhelpfulMainOption = true
  ) {
    // Get the additive scores and bin edges for this categorical feature
    let additives = this.ebm.scores[curFeatureIndex];
    let levels = this.ebm.binEdges[curFeatureIndex];
    let curFeatureName = this.ebm.featureNames[curFeatureIndex];

    // Encode the current feature value
    let curFeatureValueEncoded = 0;
    if (this.ebm.labelEncoder[curFeatureName][curFeatureValue] !== undefined) {
      curFeatureValueEncoded = parseInt(
        this.ebm.labelEncoder[curFeatureName][curFeatureValue],
        10
      );
    }

    let catOptions = [];

    // Identify interaction terms that we need to consider
    let associatedInteractions = [];

    this.ebm.interactionIndexes.forEach((indexes, curInteractionId) => {
      if (indexes.includes(curFeatureIndex)) {
        const featurePosition = indexes[0] === curFeatureIndex ? 0 : 1;

        // Need to query which bin is used for the other feature
        const otherPosition = 1 - featurePosition;
        const otherIndex = indexes[otherPosition];

        // Get sub-types for this other feature term
        const otherType = this.ebm.featureTypes[otherIndex];
        const otherName = this.ebm.featureNames[otherIndex];

        // Get the current additive scores and bin edges
        let interactionAdditives = this.ebm.interactionScores[curInteractionId];
        let interactionBinEdges =
          this.ebm.interactionBinEdges[curInteractionId];

        // Get the current score on this interaction term
        let otherBin = -1;
        if (otherType === 'continuous') {
          otherBin = searchSortedLowerIndex(
            interactionBinEdges[otherPosition],
            curExample[otherIndex]
          );
        } else {
          // Need to encode the categorical level first
          let otherLevel = parseInt(
            this.ebm.labelEncoder[otherName][curExample[otherIndex]],
            10
          );
          otherBin = interactionBinEdges[otherPosition].indexOf(otherLevel);
        }

        const featureBin = interactionBinEdges[featurePosition].indexOf(
          curFeatureValueEncoded
        );

        let featureInterScore = 0;
        if (featurePosition === 0) {
          featureInterScore = interactionAdditives[featureBin][otherBin];
        } else {
          featureInterScore = interactionAdditives[otherBin][featureBin];
        }

        // Extract the row or column where we fix the other feature and vary the
        // current feature
        let featureInterBinEdges = interactionBinEdges[featurePosition];
        const featureInterAdditives = [];

        if (featurePosition === 0) {
          for (let i = 0; i < interactionAdditives.length; i++) {
            featureInterAdditives.push(interactionAdditives[i][otherBin]);
          }
        } else {
          for (let i = 0; i < interactionAdditives[0].length; i++) {
            featureInterAdditives.push(interactionAdditives[otherBin][i]);
          }
        }

        // Register this interaction term
        associatedInteractions.push({
          interIndex: indexes,
          curInteractionId,
          featureInterScore,
          featureInterBinEdges,
          featureInterAdditives
        });
      }
    });

    for (let i = 0; i < additives.length; i++) {
      if (levels[i] !== curFeatureValueEncoded) {
        let target = levels[i];

        /**
         * Compute score gain which has two parts:
         * (1) gain from the change of main effect
         * (2) gain from the change of interaction effect
         */

        // Main effect
        const mainScoreGain = additives[i] - curFeatureScore;

        // Interaction terms
        let interScoreGain = 0;

        // A list to track all interaction score gain offsets
        // [[interaction id, interaction score gain]]
        let interScoreGains = [];

        associatedInteractions.forEach((d) => {
          const interBinId = d.featureInterBinEdges.indexOf(target);

          interScoreGain +=
            d.featureInterAdditives[interBinId] - d.featureInterScore;
          interScoreGains.push([
            d.curInteractionId,
            d.featureInterAdditives[interBinId] - d.featureInterScore
          ]);
        });

        const scoreGain = mainScoreGain + interScoreGain;

        // Skip unhelpful features
        if (cfDirection * scoreGain <= 0 && skipUnhelpfulMainOption) {
          continue;
        }

        // Filter out of bound options
        if (scoreGainBound !== null && skipUnhelpfulMainOption) {
          if (cfDirection === 1 && scoreGain > scoreGainBound) {
            continue;
          } else if (cfDirection === -1 && scoreGain < scoreGainBound) {
            continue;
          }
        }

        let targetDecoded = this.ebm.labelDecoder[curFeatureName][target];
        let distance = curCatDistance[targetDecoded];

        catOptions.push([
          targetDecoded,
          scoreGain,
          distance,
          i,
          interScoreGains
        ]);
      }
    }

    return catOptions;
  }

  /**
   * Generate options for interaction effects.
   * @param {number} curInteractionId The index of the interaction feature
   * @param {number} curFeatureIndex1 The index for the first main effect
   * @param {number} curFeatureIndex2 The index for the second main effect
   * @param {number} curFeatureScore The current score for the interaction term
   * @param {object} options Existing options for cont and cat features
   */
  generateInterOptions(
    curInteractionId,
    curFeatureIndex1,
    curFeatureIndex2,
    curFeatureScore,
    options
  ) {
    // Get sub-types for this interaction term
    let curFeatureType1 = this.ebm.featureTypes[curFeatureIndex1];
    let curFeatureType2 = this.ebm.featureTypes[curFeatureIndex2];

    // Get the sub-names for this interaction term
    let curFeatureName1 = this.ebm.featureNames[curFeatureIndex1];
    let curFeatureName2 = this.ebm.featureNames[curFeatureIndex2];

    // Get the current additive scores and bin edges
    let interactionAdditives = this.ebm.interactionScores[curInteractionId];
    let interactionBinEdges = this.ebm.interactionBinEdges[curInteractionId];

    // Encode the current example
    let encodedSample = this.ebm.sample.slice();

    for (let j = 0; j < encodedSample.length; j++) {
      if (this.ebm.featureTypes[j] === 'categorical') {
        let curEncoder = this.ebm.labelEncoder[this.ebm.featureNames[j]];

        if (curEncoder[encodedSample[j]] !== undefined) {
          encodedSample[j] = parseInt(curEncoder[encodedSample[j]], 10);
        } else {
          // Unseen level
          // Because level code starts at index 1, 0 would trigger a miss
          // during inference => 0 score
          encodedSample[j] = 0;
        }
      }
    }

    let interOptions = [];

    // Iterate through all combinations of values of two main effects
    options[curFeatureName1].forEach((opt1) => {
      options[curFeatureName2].forEach((opt2) => {
        // Locate the index for each main effect
        let bin1 = -1;
        let bin2 = -1;

        if (curFeatureType1 === 'continuous') {
          bin1 = searchSortedLowerIndex(interactionBinEdges[0], opt1[0]);
        } else {
          // Need to encode the categorical level first
          let curLevel = parseInt(
            this.ebm.labelEncoder[curFeatureName1][opt1[0]],
            10
          );
          bin1 = interactionBinEdges[0].indexOf(curLevel);
        }

        if (curFeatureType2 === 'continuous') {
          bin2 = searchSortedLowerIndex(interactionBinEdges[1], opt2[0]);
        } else {
          // Need to encode the categorical level first
          let curLevel = parseInt(
            this.ebm.labelEncoder[curFeatureName2][opt2[0]],
            10
          );
          bin2 = interactionBinEdges[1].indexOf(curLevel);
        }

        // Look up the score
        let newScore = 0;
        if (bin1 < 0 || bin2 < 0) {
          throw Error(
            `Unseen features for interaction term ${curInteractionId}.`
          );
        } else {
          newScore = interactionAdditives[bin1][bin2];
        }

        let scoreGain = newScore - curFeatureScore;

        // The score gain on the interaction term need to offset the interaction
        // score gain we have already counted on the main effect options. That
        // score is saved in the option tuple.

        // We first need to find the common interaction id
        let commonIndex = [-1, -1];

        for (let m = 0; m < opt1[4].length; m++) {
          for (let n = 0; n < opt2[4].length; n++) {
            if (opt1[4][m][0] === opt2[4][n][0]) {
              commonIndex = [m, n];
              break;
            }
          }
          if (commonIndex[0] !== -1 && commonIndex[1] !== -1) {
            break;
          }
        }

        scoreGain -= opt1[4][commonIndex[0]][1];
        scoreGain -= opt2[4][commonIndex[1]][1];

        interOptions.push([
          [opt1[0], opt2[0]],
          scoreGain,
          0.0,
          [opt1[3], opt2[3]],
          0.0
        ]);
      });
    });

    return interOptions;
  }

  /**
   * Convert found MILP solutions to data format
   * @param {object} options All possible options
   * @param {object[]} solutions Generated solutions
   * @param {boolean} isSuccessful If we can generate all requested CFs
   */
  convertCfToData(options, solutions, isSuccessful) {
    let data = [];
    let distances = [];
    let targetRanges = [];
    let scoreGains = [];

    for (let i = 0; i < solutions.length; i++) {
      let curSolution = solutions[i];
      let curCf = this.ebm.sample.slice();
      let curTargetRanges = [];
      let curScoreGains = [];

      curSolution[0].forEach((variable) => {
        if (!variable.includes(' x ')) {
          // Find the original name and bin id
          let fName = variable.replace(/(.+):\d+/, '$1');
          let binId = parseInt(variable.replace(/.+:(\d+)/, '$1'), 10);

          let curIndex = this.ebm.featureNames.indexOf(fName);
          let curType = this.ebm.featureTypes[curIndex];

          // Look up the target range
          let targetRange = [];
          if (curType === 'continuous') {
            targetRange.push(this.ebm.binEdges[curIndex][binId]);

            if (binId + 1 < this.ebm.binEdges[curIndex].length) {
              targetRange.push(this.ebm.binEdges[curIndex][binId + 1]);
            } else {
              targetRange.push(Infinity);
            }
          }

          // Alter these features on the original data point
          for (let j = 0; j < options[fName].length; j++) {
            let option = options[fName][j];

            if (option[3] === binId) {
              let targetValue = option[0];
              curCf[curIndex] = targetValue;
              curScoreGains.push(option[1]);

              // Add to target ranges as well
              if (curType === 'continuous') {
                curTargetRanges.push(targetRange);
              } else {
                curTargetRanges.push(option[0]);
              }

              break;
            }
          }
        }
      });

      // Add this CF
      data.push(curCf);
      distances.push(curSolution[1]);
      targetRanges.push(curTargetRanges);
      scoreGains.push(curScoreGains);
    }

    // Also bundle active variables with the output
    let activeVariables = [];
    solutions.forEach((sol) => {
      const activeMain = [];
      sol[0].forEach((d) => {
        if (!d.includes(' x ')) {
          activeMain.push(d);
        }
      });
      activeVariables.push(activeMain);
    });

    return {
      data,
      distances,
      targetRanges,
      scoreGains,
      isSuccessful,
      activeVariables
    };
  }

  print() {
    // this.testMILP();
    // console.log(this.xTrain.length);
    // console.log(this.xTrain[0].length);
    // console.log(this.ebm.countedScores);
  }
}

export { GAMCoach };
