class PluginRegistry {
  constructor() {
    this._plugins = []
    this._pluginsByName = {}
  }

  register(plugin) {
    if (!plugin || !plugin.name) {
      throw new Error('Plugin must have a .name property')
    }
    if (this._pluginsByName[plugin.name]) {
      throw new Error(`Plugin "${plugin.name}" already registered`)
    }
    this._plugins.push(plugin)
    this._pluginsByName[plugin.name] = plugin
  }

  get(name) {
    return this._pluginsByName[name] || null
  }

  getAll() {
    return [...this._plugins]
  }

  getConfigured() {
    return this._plugins.filter(p => p.isConfigured())
  }

  getPublicConfigs() {
    return this.getConfigured().map(p => ({
      id: p.name,
      label: p.label,
      icon: p.icon,
      description: p.description,
      configured: true,
      config: p.getPublicConfig(),
    }))
  }

  getPluginNames() {
    return this._plugins.map(p => p.name)
  }

  remove(name) {
    const plugin = this._pluginsByName[name]
    if (!plugin) return false
    this._plugins = this._plugins.filter(p => p.name !== name)
    delete this._pluginsByName[name]
    return true
  }

  clear() {
    this._plugins = []
    this._pluginsByName = {}
  }
}

module.exports = PluginRegistry
