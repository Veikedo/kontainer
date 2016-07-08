/*!
 Kontainer 0.1.0
 Copyright © Ben Quarmby 2015
 https://github.com/benquarmby/kontainer/

 This library may be used under the terms of the Apache License 2.0 (Apache).
 Please see license.txt accompanying this file for more information.
 !*/

(function(factory) {
    "use strict";

    if (typeof define === "function" && define.amd) {
        define(["exports"], factory);
    } else {
        window.kontainer = {};
        factory(window.kontainer);
    }
}(function(exports) {
    "use strict";

    var states = {
            injectable: 0,
            injecting: -1,
            resolved: 1
        },
        container,
        mockContainer;

    function validateFactory(factory) {
        if (!(factory instanceof Array)) {
            throw new Error("Factories must always be arrays.");
        }

        var i;
        var len = factory.length;
        var last = len - 1;
        var item;
        for (i = 0; i < len; i += 1) {
            item = factory[i];

            if (i === last) {
                if (typeof item !== "function") {
                    throw new Error("The last element in a factory array must be a function.");
                }
            } else if (typeof item !== "string") {
                throw new Error("Each element in a factory array before the function must be a string.");
            }
        }
    }

    function getFirstResultFromLoaders(methodName, argsExceptCallback, callback, candidateLoaders) {
        // On the first call in the stack, start with the full set of loaders
        if (!candidateLoaders) {
            candidateLoaders = ko.components["loaders"].slice(0); // Use a copy, because we'll be mutating this array
        }
        
        // Try the next candidate
        var currentCandidateLoader = candidateLoaders.shift();
        if (currentCandidateLoader) {
            var methodInstance = currentCandidateLoader[methodName];
            if (methodInstance) {
                var wasAborted = false;
                var synchronousReturnValue = methodInstance.apply(currentCandidateLoader, argsExceptCallback.concat(function(result) {
                    if (wasAborted) {
                        callback(null);
                    } else if (result !== null) {
                        // This candidate returned a value. Use it.
                        callback(result);
                    } else {
                        // Try the next candidate
                        getFirstResultFromLoaders(methodName, argsExceptCallback, callback, candidateLoaders);
                    }
                }));

                // Currently, loaders may not return anything synchronously. This leaves open the possibility
                // that we'll extend the API to support synchronous return values in the future. It won't be
                // a breaking change, because currently no loader is allowed to return anything except undefined.
                if (synchronousReturnValue !== undefined) {
                    wasAborted = true;

                    // Method to suppress exceptions will remain undocumented. This is only to keep
                    // KO's specs running tidily, since we can observe the loading got aborted without
                    // having exceptions cluttering up the console too.
                    if (!currentCandidateLoader["suppressLoaderExceptions"]) {
                        throw new Error("Component loaders must supply values by invoking the callback, not by returning values synchronously.");
                    }
                }
            } else {
                // This candidate doesn't have the relevant handler. Synchronously move on to the next one.
                getFirstResultFromLoaders(methodName, argsExceptCallback, callback, candidateLoaders);
            }
        } else {
            // No candidates returned a value
            callback(null);
        }
    }

    function Container() {
        this.registry = {};
    }

    Container.prototype = {
        constructor: Container,

        resolve: function (name, path) {
            if (!this.registry.hasOwnProperty(name)) {
                throw new Error("Unknown dependency: " +  name);
            }
            var dependency = this.registry[name];
            if (dependency.state === states.resolved) {
                return dependency.value;
            }

            path.push(name);

            if (dependency.state === states.injecting) {
                throw new Error("Cyclic dependency detected while resolving " + name + ". " + path.join(" > ") + "}");
            }

            if (dependency.state === states.injectable) {
                dependency.state = states.injecting;
                dependency.value = this.inject(dependency.factory, path);
                delete dependency.factory;
                dependency.state = states.resolved;
            }

            path.pop();

            return dependency.value;
        },

        inject: function(factory, path, custom) {
            var self = this;
            var fn = factory[factory.length - 1];
            var args = [];
            var i,
                len,
                name,
                value;

            for (i = 0, len = factory.length - 1; i < len; i += 1) {
                name = factory[i];
                value = custom && custom.hasOwnProperty(name) ? custom[name] : self.resolve(name, path);

                args.push(value);
            }

            return fn.apply(undefined, args);
        },

        registerFactory: function(name, factory) {
            if (typeof name !== "string") {
                throw new Error("The name parameter must be a string.");
            }

            validateFactory(factory);

            this.registry[name] = {
                state: states.injectable,
                factory: factory.slice()
            };
        },

        registerValue: function(name, value) {
            if (typeof name !== "string") {
                throw new Error("The name parameter must be a string.");
            }

            this.registry[name] = {
                state: states.resolved,
                value: value
            };
        },

        register: function(name, value) {
            if (value instanceof Array) {
                this.registerFactory(name, value);

                return;
            }

            this.registerValue(name, value);
        }
    };

    container = new Container();
    mockContainer = new Container();

    /**
     * Registers a factory with the container.
     * @param {String} name The name of the dependency.
     * @param {Array} factory The factory array.
     */
    exports.registerFactory = function(name, factory) {
        container.registerFactory(name, factory);
    };

    /**
     * Registers a value with the container.
     * @param {String} name The name of the dependency.
     * @param {Object} value The value.
     */
    exports.registerValue = function(name, value) {
        container.registerValue(name, value);
    };

    /**
     * Registers a dependency with the container.
     * Arrays are assumed to be factories. All other
     * types are assumed to be values.
     * @param {String} name The name of the dependency.
     * @param {Object} value The factory array or value.
     */
    exports.register = function(name, value) {
        container.register(name, value);
    };

    exports.resolve = function (serviceName) {
        return container.resolve(serviceName, []);
    };

    exports.isRegistered = function(name) {
        return container.registry.hasOwnProperty(name);
    };

    /**
     * The component loader to be registered with Knockout.
     *     ko.components.loaders.unshift(kontainer.loader);
     */
    exports.loader = {
        loadComponent: function(componentName, componentConfig, callback) {
            var url = componentConfig["requireDefault"] || (componentConfig["configName"] && componentConfig["require"]);
            if (typeof url === "string") {
                require([url], function (module) {
                    var configName = componentConfig["configName"] || "default";
                    var config = module[configName];

                    var result = {},
                        makeCallBackWhenZero = 2,
                        tryIssueCallback = function() {
                            if (--makeCallBackWhenZero === 0) {
                                callback(result);
                            }
                        };

                    if (config.viewModel) {
                        getFirstResultFromLoaders("loadViewModel", [componentName, config.viewModel], function(resolvedViewModel) {
                            result["createViewModel"] = resolvedViewModel;
                            tryIssueCallback();
                        });
                    } else {
                        tryIssueCallback();
                    }

                    if (config.template) {
                        getFirstResultFromLoaders("loadTemplate", [componentName, config.template], function (resolvedTemplate) {
                            result["template"] = resolvedTemplate;
                            tryIssueCallback();
                        });
                    } else {
                        tryIssueCallback();
                    }
                });
            } else {
                callback(null);
            }
        },
        loadViewModel: function(componentName, viewModelConfig, callback) {
            if (!(viewModelConfig instanceof Array)) {
                callback(null);

                return;
            }

            validateFactory(viewModelConfig);

            callback(function(params, componentInfo) {
                return container.inject(viewModelConfig, [componentName], {
                    params: params,
                    componentInfo: componentInfo
                });
            });
        }
    };

    /**
     * The mock namespace is used for isolating services
     * and view models for unit testing.
     */
    exports.mock = {
        /**
         * Registers a factory with the mock container.
         * @param {String} name The name of the dependency.
         * @param {Array} factory The factory array.
         */
        registerFactory: function(name, factory) {
            mockContainer.registerFactory(name, factory);
        },

        /**
         * Registers a value with the mock container.
         * @param {String} name The name of the dependency.
         * @param {Object} value The value.
         */
        registerValue: function(name, value) {
            mockContainer.registerValue(name, value);
        },

        /**
         * Registers a dependency with the mock container.
         * Arrays are assumed to be factories. All other
         * types are assumed to be values.
         * @param {String} name The name of the dependency.
         * @param {Object} value The factory array or value.
         */
        register: function(name, value) {
            mockContainer.register(name, value);
        },

        /**
         * Resolves a factory, injecting it with dependencies
         * from the mock container or specified custom values.
         * @param {Array} factory The factory array.
         * @param {Object} custom A dictionary of custom values to inject.
         * @returns {Object} The product of the factory.
         */
        inject: function(factory, custom) {
            validateFactory(factory);

            return mockContainer.inject(factory, [], custom);
        }
    };
}));
