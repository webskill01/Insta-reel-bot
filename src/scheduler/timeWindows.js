const config = require('../../config/default');

/**
 * Generates a random Date within a time window for today.
 * @param {{ start: string, end: string }} window - e.g. { start: '07:00', end: '09:30' }
 * @returns {Date}
 */
function randomTimeInWindow(window) {
  const now = new Date();
  const [startH, startM] = window.start.split(':').map(Number);
  const [endH, endM] = window.end.split(':').map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  const randomMinutes = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes));

  const result = new Date(now);
  result.setHours(Math.floor(randomMinutes / 60), randomMinutes % 60, Math.floor(Math.random() * 60), 0);

  return result;
}

/**
 * Generates randomized posting times for an account for today.
 * For 3 posts/day: one time per window (morning, afternoon, evening).
 * For 2 posts/day: randomly selects 2 of 3 windows.
 * For 1 post/day: randomly selects 1 window.
 * @param {number} postsPerDay
 * @returns {Date[]} sorted array of Date objects for today
 */
function generateDailyTimes(postsPerDay) {
  const windows = config.postingWindows;
  const windowKeys = Object.keys(windows); // ['morning', 'afternoon', 'evening']

  let selectedKeys;
  if (postsPerDay >= windowKeys.length) {
    selectedKeys = [...windowKeys];
    // If more posts than windows, add extra random windows
    while (selectedKeys.length < postsPerDay) {
      selectedKeys.push(windowKeys[Math.floor(Math.random() * windowKeys.length)]);
    }
  } else {
    // Shuffle and pick N
    const shuffled = [...windowKeys].sort(() => Math.random() - 0.5);
    selectedKeys = shuffled.slice(0, postsPerDay);
  }

  const now = new Date();
  const futureTimes = selectedKeys
    .map(key => randomTimeInWindow(windows[key]))
    .filter(t => t > now);
  futureTimes.sort((a, b) => a.getTime() - b.getTime());

  return futureTimes;
}

module.exports = { generateDailyTimes, randomTimeInWindow };
