// Keep native synchronous handlers synchronous while awaiting EVM replay when needed.
function settle(value, next) { return value?.then ? value.then(next) : next(value); }
function settleAll(values, next) { return values.some(value => value?.then) ? Promise.all(values).then(next) : next(values); }
module.exports = { settle, settleAll };
