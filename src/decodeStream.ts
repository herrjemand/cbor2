import {
  MT,
  NUMBYTES,
  SYMS,
} from './constants.js';
import {parseHalf} from './float.js';
import {Simple} from './simple.js'

const TD = new TextDecoder('utf8', {fatal: true});

export interface DecodeOptions {
  /**
   * Maximum allowed depth to parse into CBOR structures.  This limit is
   * security-relevant for untrusted inputs.  May be set to Infinity for
   * trusted inputs, but be careful!
   * @default 1024
   */
  max_depth?: number;
}

export type DecodeValue =
  Simple | Symbol | Uint8Array | bigint | boolean | number | number | string |
  null | undefined;

type ValueGenerator =
  Generator<[number, number, DecodeValue], undefined, undefined>;

export class DecodeStream {
  #src;
  #view;
  #offset = 0;
  #opts: Required<DecodeOptions>;

  public constructor(src: Uint8Array, opts?: DecodeOptions) {
    this.#src = src;
    this.#view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    this.#opts = {
      max_depth: 1024,
      ...opts,
    };
  }

  public [Symbol.iterator](): ValueGenerator {
    return this.#nextVal(0);
  }

  *#nextVal(depth: number): ValueGenerator {
    if (depth++ > this.#opts.max_depth) {
      throw new Error(`Maximum depth ${this.#opts.max_depth} exceeded`);
    }

    // Will throw when out of data
    const octet = this.#view.getUint8(this.#offset++);
    const mt = octet >> 5;
    const ai = octet & 0x1f;
    let val: DecodeValue = ai;
    let simple = false;

    switch (ai) {
      case NUMBYTES.ONE:
        val = this.#view.getUint8(this.#offset++);
        simple = true;
        break;
      case NUMBYTES.TWO:
        if (mt === MT.SIMPLE_FLOAT) {
          val = parseHalf(this.#src, this.#offset);
        } else {
          val = this.#view.getUint16(this.#offset, false);
        }
        this.#offset += 2;
        break;
      case NUMBYTES.FOUR:
        if (mt === MT.SIMPLE_FLOAT) {
          val = this.#view.getFloat32(this.#offset, false);
        } else {
          val = this.#view.getUint32(this.#offset, false);
        }
        this.#offset += 4;
        break;
      case NUMBYTES.EIGHT: {
        if (mt === MT.SIMPLE_FLOAT) {
          val = this.#view.getFloat64(this.#offset, false);
        } else {
          val = this.#view.getBigUint64(this.#offset, false);
          if (val <= Number.MAX_SAFE_INTEGER) {
            val = Number(val);
          }
        }
        this.#offset += 8;
        break;
      }
      case 28:
      case 29:
      case 30:
        throw new Error(`Additional info not implemented: ${ai}`);
      case NUMBYTES.INDEFINITE:
        switch (mt) {
          case MT.POS_INT:
          case MT.NEG_INT:
          case MT.TAG:
            throw new Error(`Invalid indefinite encoding for MT ${mt}`);
          case MT.SIMPLE_FLOAT:
            yield [mt, ai, SYMS.BREAK];
            return;
        }
        val = -1;
        break;
      default:
        simple = true;
    }

    switch (mt) {
      case MT.POS_INT:
        yield [mt, ai, val];
        break;
      case MT.NEG_INT:
        yield [mt, ai, (typeof val === 'bigint') ? -1n - val : -1 - Number(val)];
        break;
      case MT.BYTE_STRING:
        if (val === -1) {
          yield *this.#stream(mt, depth);
        } else {
          yield [mt, ai, this.#read(val as number)];
        }
        break;
      case MT.UTF8_STRING:
        if (val === -1) {
          yield *this.#stream(mt, depth);
        } else {
          yield [mt, ai, TD.decode(this.#read(val as number))];
        }
        break;
      case MT.ARRAY:
        if (val === -1) {
          yield *this.#stream(mt, depth, false);
        } else {
          const nval = Number(val);
          yield [mt, ai, nval];
          for (let i = 0; i < nval; i++) {
            yield *this.#nextVal(depth + 1);
          }
        }
        break;
      case MT.MAP:
        if (val === -1) {
          yield *this.#stream(mt, depth, false);
        } else {
          const nval = Number(val);
          yield [mt, ai, nval];
          for (let i = 0; i < nval; i++) {
            yield *this.#nextVal(depth);
            yield *this.#nextVal(depth);
          }
        }
        break;
      case MT.TAG:
        yield [mt, ai, val];
        yield *this.#nextVal(depth);
        break;
      case MT.SIMPLE_FLOAT:
        if (simple) {
          switch (val) {
            case 20: val = false; break;
            case 21: val = true; break;
            case 22: val = null; break;
            case 23: val = undefined; break;
            default: val = new Simple(Number(val));
          }
        }
        yield [mt, ai, val];
        break;
    }
  }

  #read(size: number): Uint8Array {
    return this.#src.subarray(this.#offset, (this.#offset += size));
  }

  *#stream(mt: number, depth: number, check = true): ValueGenerator {
    yield [mt, NUMBYTES.INDEFINITE, SYMS.STREAM];

    let streaming = true;
    while (streaming) {
      const nextVal = this.#nextVal(depth).next();
      if (nextVal.done) {
        throw new Error('End of input when streaming');
      }
      const [nmt, ai, val] = nextVal.value;
      if (val === SYMS.BREAK) {
        streaming = false;
      } else if (check && (nmt !== mt)) {
        throw new Error(`Unmatched major type.  Expected ${mt}, got ${nmt}.`);
      }
      yield [nmt, ai, val];
    }
  }
}
