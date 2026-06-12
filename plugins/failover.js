async function tryPayment(registry, order, triedMethods = []) {
  const availablePlugins = registry.getConfigured()
  const failures = []

  for (const plugin of availablePlugins) {
    if (triedMethods.includes(plugin.name)) continue

    try {
      const result = await plugin.createPayment(order)
      return {
        success: true,
        method: plugin.name,
        result,
        failures,
      }
    } catch (err) {
      const failure = { method: plugin.name, error: err.message }
      failures.push(failure)
      triedMethods.push(plugin.name)
    }
  }

  return {
    success: false,
    method: null,
    result: null,
    failures,
    error: 'All payment methods failed',
  }
}

module.exports = { tryPayment }
