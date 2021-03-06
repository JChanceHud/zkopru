/* eslint-disable jest/no-hooks */
import BN from 'bn.js'
import { Field } from '~babyjubjub'

describe('finite field', () => {
  let constant: Field
  beforeAll(() => {
    constant = new Field(18)
  })
  it('should accept number for its constructor parameter', () => {
    const a = new Field(18)
    const b = Field.from(18)
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
  it('should accept string string for its constructor parameter', () => {
    const a = new Field('18')
    const b = Field.from('18')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
  it('should accept hex string with 0x prefix for its constructor parameter', () => {
    const a = new Field('0x12')
    const b = Field.from('0x12')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
  it('should return same hex', () => {
    const f = new Field('0xabcd1234abcd1234')
    expect(f.toHex(8)).toStrictEqual('0xabcd1234abcd1234')
  })
  it('should return cyclic hex for a number beyond the field range', () => {
    const f = new Field(
      '0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    )
    expect(f.toHex(32)).not.toStrictEqual(
      '0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    )
  })
  it('should accept Buffer obj for its constructor parameter', () => {
    const a = new Field(Buffer.from('12', 'hex'))
    const b = Field.from(Buffer.from('12', 'hex'))
    expect(new Field(Buffer.from('12', 'hex'))).toBeDefined()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
  it('should accept BN object for its constructor parameter', () => {
    const a = new Field(new BN(18))
    const b = Field.from(new BN(18))
    expect(new Field(new BN(18))).toBeDefined()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
  it('should accept itself for its constructor parameter', () => {
    const a = new Field(new Field(18))
    const b = Field.from(new Field(18))
    expect(new Field(new Field(18))).toBeDefined()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).toBeInstanceOf(Field)
    expect(b).toBeInstanceOf(Field)
    expect(constant.eq(a)).toBe(true)
    expect(constant.eq(b)).toBe(true)
  })
})
describe('cyclic group', () => {
  it('a + (-a) = 0', () => {
    const a = new Field(18)
    const b = new Field(-18)
    expect(a.add(b).isZero()).toBe(true)
  })
  it('a >= 0 and -a >= 0', () => {
    const a = new Field(18)
    const b = new Field(-18)
    expect(a.gtn(0)).toBe(true)
    expect(b.gtn(0)).toBe(true)
  })
  it('a - b > a when b > a', () => {
    const a = new Field(18)
    const b = new Field(20)
    expect(a.sub(b).gt(a)).toBe(true)
  })
})
