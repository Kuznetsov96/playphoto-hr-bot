import { describe, expect, it } from 'vitest';
import { STAFF_TEXTS } from '../../constants/staff-texts.js';

const shift = { location: 'Аркадія', date: 'субота, 15 серпня', time: '10:00–19:00' };

describe('replacement auto-confirm texts', () => {
  it('addresses the photographer in the feminine, as every photographer is a woman', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toMatch(/позначала/u);
    expect(text).not.toMatch(/позначав/u);
  });

  /**
   * Declining still needs no explanation — but it is now a button press rather
   * than silence. When this text was written the message carried no keyboard,
   * so ignoring it was the only way to say no; telling her to ignore a message
   * that has a "Не можу" button under it contradicts what she can see.
   */
  it('tells an unavailable-wave candidate that declining needs no explanation', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toMatch(/нічого пояснювати не треба/u);
    expect(text).not.toMatch(/пропусти це повідомлення/u);
  });

  it('names the shift in the unavailable-wave offer', () => {
    const text = STAFF_TEXTS['staff-replacement-offer-unavailable-wave'](shift);
    expect(text).toContain('Аркадія');
    expect(text).toContain('субота, 15 серпня');
    expect(text).toContain('10:00–19:00');
  });

  /**
   * The neutral offer goes to candidates who marked nothing, so it must not
   * claim she declared this day busy — and it still has to name the shift.
   */
  it('names the shift in the neutral offer without claiming she marked the day', () => {
    const text = STAFF_TEXTS['staff-replacement-offer'](shift);
    expect(text).toContain('Аркадія');
    expect(text).toContain('субота, 15 серпня');
    expect(text).toContain('10:00–19:00');
    expect(text).not.toMatch(/зайнят/u);
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
