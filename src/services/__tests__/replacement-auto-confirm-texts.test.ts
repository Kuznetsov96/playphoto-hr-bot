import { describe, expect, it } from 'vitest';
import { STAFF_TEXTS } from '../../constants/staff-texts.js';

const shift = { location: 'Аркадія', date: 'субота, 15 серпня', time: '10:00–19:00' };

describe('replacement auto-confirm texts', () => {
  it('addresses the photographer in the feminine, as every photographer is a woman', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toMatch(/позначала/u);
    expect(text).not.toMatch(/позначав/u);
  });

  it('tells an unavailable-wave candidate that skipping needs no explanation', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toMatch(/пропусти/u);
  });

  it('names the shift in the unavailable-wave offer', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toContain('Аркадія');
    expect(text).toContain('субота, 15 серпня');
    expect(text).toContain('10:00–19:00');
  });

  it('thanks a candidate whose offer closed', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-closed'](shift);
    expect(text).toMatch(/відгукнулася/u);
  });

  it('tells a restored candidate the shift is free again', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-reopened'](shift);
    expect(text).toMatch(/знову вільна/u);
    expect(text).toMatch(/готова/u);
  });
});
