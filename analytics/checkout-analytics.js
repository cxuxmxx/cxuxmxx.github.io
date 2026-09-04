(function (window, document) {
  'use strict';

  var DEFAULT_OPTIONS = {
    enabled: true,
    endpoint: '/analytics/events',
    autoPageView: true,
    autoClick: true,
    maxQueueSize: 100,
    flushIntervalMs: 5000,
    sendTimeoutMs: 800,
    debug: false
  };

  var SENSITIVE_KEYS = /card|cvc|cvv|password|passwd|pin|resident|rrn|ssn|account|phone|email|address/i;
  var state = {
    initialized: false,
    context: {},
    options: copy(DEFAULT_OPTIONS),
    queue: [],
    flushing: false,
    flushTimer: null
  };

  function copy(source) {
    var target = {};
    Object.keys(source || {}).forEach(function (key) {
      target[key] = source[key];
    });
    return target;
  }

  function merge() {
    var result = {};
    Array.prototype.slice.call(arguments).forEach(function (source) {
      Object.keys(source || {}).forEach(function (key) {
        if (source[key] !== undefined) {
          result[key] = source[key];
        }
      });
    });
    return result;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function uuid(prefix) {
    var value = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = Math.random() * 16 | 0;
      var digit = char === 'x' ? random : (random & 0x3 | 0x8);
      return digit.toString(16);
    });
    return (prefix || 'id') + '_' + value;
  }

  function storageGet(storage, key) {
    try {
      return storage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function storageSet(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (error) {
      // Ignore storage failures. Analytics must never affect checkout.
    }
  }

  function getOrCreateId(storage, key, prefix) {
    var existing = storageGet(storage, key);
    if (existing) {
      return existing;
    }

    var created = uuid(prefix);
    storageSet(storage, key, created);
    return created;
  }

  function getSessionId() {
    return getOrCreateId(window.sessionStorage, 'checkout_analytics_session_id', 'sess');
  }

  function getAnonymousId() {
    return getOrCreateId(window.localStorage, 'checkout_analytics_anonymous_id', 'anon');
  }

  function sanitize(value, depth) {
    if (value == null) {
      return value;
    }

    if (depth > 4) {
      return '[Truncated]';
    }

    if (Array.isArray(value)) {
      return value.slice(0, 30).map(function (item) {
        return sanitize(item, depth + 1);
      });
    }

    if (typeof value === 'object') {
      var result = {};
      Object.keys(value).slice(0, 80).forEach(function (key) {
        if (SENSITIVE_KEYS.test(key)) {
          result[key] = '[Filtered]';
          return;
        }
        result[key] = sanitize(value[key], depth + 1);
      });
      return result;
    }

    if (typeof value === 'string') {
      return value.length > 1000 ? value.slice(0, 1000) : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    return String(value);
  }

  function buildEvent(eventName, properties) {
    return merge(state.context, {
      eventId: uuid('evt'),
      eventName: eventName,
      occurredAt: nowIso(),
      pageUrl: window.location.href,
      referrer: document.referrer || null,
      userAgent: window.navigator.userAgent,
      sessionId: state.context.sessionId || getSessionId(),
      anonymousUserId: state.context.anonymousUserId || getAnonymousId(),
      properties: sanitize(properties || {}, 0)
    });
  }

  function log() {
    if (!state.options.debug || !window.console) {
      return;
    }
    window.console.log.apply(window.console, ['[checkoutAnalytics]'].concat(Array.prototype.slice.call(arguments)));
  }

  function enqueue(event) {
    if (!state.options.enabled) {
      return;
    }

    if (state.queue.length >= state.options.maxQueueSize) {
      state.queue.shift();
    }

    state.queue.push(event);
    flushSoon();
  }

  function flushSoon() {
    if (state.flushTimer) {
      return;
    }

    state.flushTimer = window.setTimeout(function () {
      state.flushTimer = null;
      flush();
    }, 0);
  }

  function flush() {
    if (state.flushing || state.queue.length === 0 || !state.options.enabled) {
      return;
    }

    state.flushing = true;
    var event = state.queue.shift();
    send(event, function () {
      state.flushing = false;
      if (state.queue.length > 0) {
        flushSoon();
      }
    });
  }

  function send(event, done) {
    var body = JSON.stringify(event);
    var endpoint = state.options.endpoint;

    try {
      if (window.navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        var accepted = window.navigator.sendBeacon(endpoint, blob);
        if (accepted) {
          log('sent by beacon', event.eventName);
          done();
          return;
        }
      }

      if (window.fetch) {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'same-origin'
        }).catch(function () {
          // Drop on failure. Checkout must not wait for analytics.
        }).finally(done);
        return;
      }
    } catch (error) {
      log('send failed', error);
    }

    done();
  }

  function track(eventName, properties) {
    try {
      if (!eventName || typeof eventName !== 'string') {
        return;
      }
      enqueue(buildEvent(eventName, properties));
    } catch (error) {
      log('track failed', error);
    }
  }

  function setContext(context) {
    state.context = merge(state.context, sanitize(context || {}, 0));
  }

  function init(context, options) {
    state.options = merge(DEFAULT_OPTIONS, options || {});
    setContext(merge({
      sessionId: getSessionId(),
      anonymousUserId: getAnonymousId(),
      sdkName: 'checkout-analytics-js',
      sdkVersion: '0.1.0'
    }, context || {}));

    if (state.initialized) {
      return;
    }

    state.initialized = true;
    bindLifecycleEvents();

    if (state.options.autoClick) {
      bindAutoClickEvents();
    }

    if (state.options.autoPageView) {
      track('page_view', {
        title: document.title,
        path: window.location.pathname,
        screenName: state.context.screenName || null
      });
    }
  }

  function bindLifecycleEvents() {
    window.setInterval(flush, state.options.flushIntervalMs);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });

    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }

  function bindAutoClickEvents() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      while (target && target !== document) {
        if (target.getAttribute && target.getAttribute('data-analytics-event')) {
          track(target.getAttribute('data-analytics-event'), {
            action: 'click',
            elementId: target.id || null,
            elementName: target.getAttribute('name') || null,
            analyticsLabel: target.getAttribute('data-analytics-label') || null,
            analyticsValue: target.getAttribute('data-analytics-value') || null
          });
          return;
        }
        target = target.parentNode;
      }
    }, true);
  }

  window.checkoutAnalytics = {
    init: init,
    setContext: setContext,
    track: track,
    flush: flush,
    enable: function () { state.options.enabled = true; },
    disable: function () { state.options.enabled = false; },
    version: '0.1.0'
  };
})(window, document);