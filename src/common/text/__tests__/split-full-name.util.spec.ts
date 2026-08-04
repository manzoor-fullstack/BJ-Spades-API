import {
  initialsOf,
  joinFullName,
  splitFullName,
} from '../split-full-name.util';

describe('splitFullName', () => {
  it('splits a simple two-part name', () => {
    expect(splitFullName('John Mitchell')).toEqual({
      firstName: 'John',
      lastName: 'Mitchell',
    });
  });

  it('splits on the first space, keeping the rest as lastName', () => {
    expect(splitFullName('Mary Jane Watson')).toEqual({
      firstName: 'Mary',
      lastName: 'Jane Watson',
    });
  });

  it('allows a single-word name with an empty lastName', () => {
    expect(splitFullName('Prince')).toEqual({
      firstName: 'Prince',
      lastName: '',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(splitFullName('  John Mitchell  ')).toEqual({
      firstName: 'John',
      lastName: 'Mitchell',
    });
  });

  it('collapses repeated internal whitespace', () => {
    expect(splitFullName('John    Mitchell')).toEqual({
      firstName: 'John',
      lastName: 'Mitchell',
    });
  });

  it('handles tabs and newlines as whitespace', () => {
    expect(splitFullName('John\tMitchell')).toEqual({
      firstName: 'John',
      lastName: 'Mitchell',
    });
  });

  it('returns empty parts for an empty string', () => {
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: '' });
  });

  it('preserves hyphenated and apostrophe surnames', () => {
    expect(splitFullName("Anne-Marie O'Brien")).toEqual({
      firstName: 'Anne-Marie',
      lastName: "O'Brien",
    });
  });

  it('preserves non-ASCII characters', () => {
    expect(splitFullName('José Álvarez')).toEqual({
      firstName: 'José',
      lastName: 'Álvarez',
    });
  });
});

describe('joinFullName', () => {
  it('joins both parts', () => {
    expect(joinFullName('John', 'Mitchell')).toBe('John Mitchell');
  });

  it('does not leave a trailing space when lastName is empty', () => {
    expect(joinFullName('Prince', '')).toBe('Prince');
  });

  it('round-trips through splitFullName', () => {
    const original = 'Mary Jane Watson';
    const { firstName, lastName } = splitFullName(original);

    expect(joinFullName(firstName, lastName)).toBe(original);
  });
});

describe('initialsOf', () => {
  it('returns upper-case initials', () => {
    expect(initialsOf('john', 'mitchell')).toBe('JM');
  });

  it('returns a single initial when there is no last name', () => {
    expect(initialsOf('Prince', '')).toBe('P');
  });

  it('falls back to ? when both are empty', () => {
    expect(initialsOf('', '')).toBe('?');
  });
});
