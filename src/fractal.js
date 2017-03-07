/* eslint "import/no-dynamic-require": "off" */

const _ = require('lodash');
const EventEmitter = require('eventemitter2').EventEmitter2;
const utils = require('@frctl/utils');
const adapters = require('@frctl/adapters');
const fs = require('@frctl/ffs');
const assert = require('check-types').assert;
const defaults = require('../config');
const transform = require('./transformer');
const adapterPlugin = require('./files/plugins/adapter');

const entities = ['files', 'components'];

const refs = {
  src: new WeakMap(),
  config: new WeakMap(),
  adapters: new WeakMap(),
  parsers: new WeakMap(),
  interfaces: new WeakMap()
};

class Fractal extends EventEmitter {

  /**
   * Insantiate a new Fractal instance
   *
   * @param  {object} [config={}] A configuration object
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  constructor(config = {}) {
    assert.maybe.object(config, `Fractal.constructor: config must be an object [config-invalid]`);

    super({
      wildcard: true
    });

    config = utils.defaultsDeep(config || {}, defaults);
    refs.config.set(this, config);

    if (config.src) {
      this.addSrc(config.src);
    }

    const parsers = new Map();
    const interfaces = new Map();
    entities.forEach(name => {
      parsers.set(name, _.get(config, `parsers.${name}`, require(`./${name}/parser`)()));
      interfaces.set(name, _.get(config, `interfaces.${name}`, require(`./${name}/api`)(this)));
    });
    refs.parsers.set(this, parsers);
    refs.interfaces.set(this, interfaces);

    refs.adapters.set(this, new Map());
  }

  /**
   * Add a filesystem src directory
   *
   * @param  {string|array} src A source path or array of source paths
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  addSrc(src) {
    const sources = refs.src.get(this) || [];
    refs.src.set(this, sources.concat(utils.normalizePaths(src)));
    return this;
  }

  /**
   * Add a plugin to the parser
   *
   * @param  {function} plugin Parser plugin to add
   * @param  {string} [target=components] The parser stack to add the plugin to
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  addPlugin(plugin, target = 'components') {
    assert.function(plugin, `Fractal.addPlugin: plugin argument must be a function [plugin-invalid]`);
    assert.maybe.string(target, `Fractal.addPlugin: target argument must be a string or undefined [target-invalid]`);

    this.parsers.get(target).use(plugin);
    return this;
  }

  /**
   * Add an API method
   *
   * @param  {string} name The name of the method
   * @param  {function} handler The function to be used as the method
   * @param  {string} [target=components] The result set to apply the method to
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  addMethod(name, handler, target = 'components') {
    assert.string(name, `Fractal.addMethod: name argument must be a string [name-invalid]`);
    assert.function(handler, `Fractal.addMethod: handler argument must be a function [handler-invalid]`);
    assert.maybe.string(target, `Fractal.addMethod: target argument must be a string or undefined [target-invalid]`);

    this.interfaces.get(target).addMethod(name, handler);
    return this;
  }

  /**
   * Add an extension
   *
   * @param  {function} extension The extension wrapper function
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  addExtension(extension) {
    assert.function(extension, `Fractal.addExtension handler argument must be a function [extension-invalid]`);
    extension(this);
    return this;
  }

  /**
   * Add a render adapter
   *
   * @param  {object|string} adapter The adapter object or name of the pre-defined adapter to register
   * @param  {opts} adapter The adapter to register
   * @return {Fractal} Returns a reference to the Fractal instance
   */
  addAdapter(adapter, opts = {}) {
    if (typeof adapter === 'string' && adapters[adapter]) {
      adapter = adapters[adapter](opts);
    }
    assert.like(adapter, {name: 'name', render: function () {}}, `'adapter' must be an object with 'name', 'match', and 'render' properties [adapter-invalid]`);

    this.addPlugin(adapterPlugin({
      name: adapter.name,
      match: adapter.match
    }), 'files');

    this.addMethod(`render.${adapter.name}`, function (file, context, done) {
      assert.instance(file, fs.File, `${adapter.name}.render: requires a 'file' argument of type File [file-invalid]`);
      assert.object(context, `${adapter.name}.render: requires a 'context' argument of type object [context-invalid]`);
      assert.function(done, `${adapter.name}.render: requires a 'done' callback [done-invalid]`);

      return adapter.render(file, context, done);
    });

    refs.adapters.get(this).set(adapter.name, adapter);
    return this;
  }

  /**
   * Read and process all source directories
   *
   * @param  {function} [callback] A callback function
   */
  parse(callback) {
    assert.function(callback, `Fractal.parse: callback must be a function [callback-invalid]`);

    this.emit('parse.start');

    fs.readDir(this.src).then(input => {
      return this.process('files', input).then(files => {
        const components = transform(files.getAll());
        return this.process('components', components).then(components => {
          Object.defineProperty(components, 'files', {value: files});
          this.emit('parse.complete', components, files);
          callback(null, components, files);
        });
      });
    }).catch(callback);
  }

  /**
   * Run a set of input through the specified entity parser and return the
   * appropriate entity API object.
   *
   * @param  {string} [target] Entity type - `files` or `components`
   * @return {Promise} Returns a Promise that resolves to an entity API object
   */
  process(target, input = []) {
    const parser = this.getParser(target);
    const api = this.getInterface(target);
    return parser.process(input).then(data => api.generate({
      $data: data
    }));
  }

  /**
   * Retrieve an entity parser function
   *
   * @param  {string} [name] Entity type - `files` or `components`
   * @return {function} A parser function.
   */
  getParser(name) {
    if (!entities.includes(name)) {
      throw new TypeError(`Fractal.getParser: 'parser' must one of [${entities.join(', ')}] [parser-invalid]`);
    }
    return this.parsers.get(name);
  }

  /**
   * Retrieve an entity API builder function
   *
   * @param  {string} [name] Entity type - `files` or `components`
   * @return {function} An API builder function.
   */
  getInterface(name) {
    if (!entities.includes(name)) {
      throw new TypeError(`Fractal.getInterface: 'interface' must one of [${entities.join(', ')}] [interface-invalid]`);
    }
    return this.interfaces.get(name);
  }

  /**
   * Get a Map of entity interfaces
   */
  get interfaces() {
    return refs.interfaces.get(this);
  }

  /**
   * Get a Map of entity parsers
   */
  get parsers() {
    return refs.parsers.get(this);
  }

  /**
   * Get a list of registered adapters
   */
  get adapters() {
    return refs.adapters.get(this);
  }

  /**
   * Get the default (first registered) adapter
   */
  get defaultAdapter() {
    const adapters = refs.adapters.get(this);
    if (adapters.size) {
      return adapters.values().next().value;
    }
    return undefined;
  }

  /**
   * Return the configuration object
   */
  get config() {
    return refs.config.get(this);
  }

  /**
   * Return the array of target src directories
   */
  get src() {
    return refs.src.get(this);
  }

}

module.exports = Fractal;
