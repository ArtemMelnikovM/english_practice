/**
 * Shared dictionary sync: localStorage + Firestore when signed in (Firebase Auth).
 * Path: users/{uid}/sync/dictionary — document { version, entries, updatedAt }.
 */
(function (global) {
  'use strict';

  var DICT_STORAGE_KEY = 'hr-interview-examples';
  var MIGRATION_KEY_PREFIX = 'dict-firebase-migrated-';
  /** sessionStorage: use app without Firebase account (this tab only) */
  var SESSION_SKIP_KEY = 'eaap-auth-local-only';

  var firebaseConfig = {
    apiKey: 'AIzaSyBJRVGrJeHD3MdLzn_SQmcPV7RBvyi9sMk',
    authDomain: 'english-asap-1dee8.firebaseapp.com',
    projectId: 'english-asap-1dee8',
    storageBucket: 'english-asap-1dee8.firebasestorage.app',
    messagingSenderId: '143254633918',
    appId: '1:143254633918:web:179dcf939803cff404cdef',
    measurementId: 'G-VYEP4THE2Y'
  };

  var app = null;
  var auth = null;
  var db = null;
  var currentUser = null;
  /** @type {Array|null} null = signed in but initial load not finished */
  var cachedList = null;
  var snapshotUnsub = null;
  var saveTimer = null;
  var updateListeners = [];
  var lastPushedJson = null;
  var authUiListeners = [];
  var authUiFirstEventDone = false;
  /** Last user passed to UI from onAuthStateChanged (not auth.currentUser — avoids races). */
  var lastAuthUiUser = null;
  /** Avoid flashing login: Firebase may emit null once before restoring persisted session. */
  var authNullUiTimer = null;

  function clearAuthNullUiTimer() {
    if (authNullUiTimer) {
      clearTimeout(authNullUiTimer);
      authNullUiTimer = null;
    }
  }

  function notifyAuthUi(user) {
    authUiFirstEventDone = true;
    lastAuthUiUser = user == null ? null : user;
    authUiListeners.forEach(function (fn) {
      try {
        fn(lastAuthUiUser);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function scheduleAuthUiAfterNullUser() {
    clearAuthNullUiTimer();
    authNullUiTimer = setTimeout(function () {
      authNullUiTimer = null;
      var late = auth && auth.currentUser ? auth.currentUser : null;
      notifyAuthUi(late);
    }, 160);
  }

  function localGet() {
    try {
      var raw = localStorage.getItem(DICT_STORAGE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function localSet(list) {
    try {
      localStorage.setItem(DICT_STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function dictRef(uid) {
    return db.collection('users').doc(uid).collection('sync').doc('dictionary');
  }

  function notifyUpdate() {
    updateListeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    });
  }

  function flushPush(uid, list) {
    if (!uid || !db || !Array.isArray(list)) return;
    var json = JSON.stringify(list);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    dictRef(uid)
      .set({
        version: 1,
        entries: list,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      })
      .catch(function (e) {
        console.error('Dictionary sync failed:', e);
        lastPushedJson = null;
      });
  }

  function debouncedPush(uid, list) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      flushPush(uid, list);
    }, 450);
  }

  function startListener(uid) {
    if (snapshotUnsub) {
      snapshotUnsub();
      snapshotUnsub = null;
    }
    snapshotUnsub = dictRef(uid).onSnapshot(function (snap) {
      if (!currentUser || currentUser.uid !== uid) return;

      if (!snap.exists) {
        var empty = [];
        if (JSON.stringify(empty) === JSON.stringify(cachedList)) return;
        cachedList = empty;
        localSet(empty);
        lastPushedJson = '[]';
        notifyUpdate();
        return;
      }

      var data = snap.data();
      var entries = data.entries;
      var incoming = Array.isArray(entries) ? entries : [];
      if (JSON.stringify(incoming) === JSON.stringify(cachedList)) return;

      cachedList = incoming;
      localSet(cachedList);
      lastPushedJson = JSON.stringify(cachedList);
      notifyUpdate();
    });
  }

  function hydrateFromCloud(uid) {
    var ref = dictRef(uid);
    ref
      .get()
      .then(function (snap) {
        if (!currentUser || currentUser.uid !== uid) return;

        var remoteEntries =
          snap.exists && Array.isArray(snap.data().entries) ? snap.data().entries : [];

        if (remoteEntries.length > 0) {
          cachedList = remoteEntries;
          localSet(cachedList);
          lastPushedJson = JSON.stringify(cachedList);
          startListener(uid);
          notifyUpdate();
          return;
        }

        var local = localGet();
        cachedList = local;
        localSet(local);

        if (local.length > 0) {
          lastPushedJson = JSON.stringify(local);
          ref
            .set({
              version: 1,
              entries: local,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            })
            .then(function () {
              if (!localStorage.getItem(MIGRATION_KEY_PREFIX + uid)) {
                localStorage.setItem(MIGRATION_KEY_PREFIX + uid, '1');
              }
              if (!currentUser || currentUser.uid !== uid) return;
              startListener(uid);
              notifyUpdate();
            })
            .catch(function (e) {
              console.error(e);
              startListener(uid);
              notifyUpdate();
            });
          return;
        }

        lastPushedJson = '[]';
        startListener(uid);
        notifyUpdate();
      })
      .catch(function (e) {
        console.error(e);
        cachedList = localGet();
        localSet(cachedList);
        notifyUpdate();
      });
  }

  function onAuthStateChangedHandler(user) {
    if (snapshotUnsub) {
      snapshotUnsub();
      snapshotUnsub = null;
    }
    clearTimeout(saveTimer);
    currentUser = user;
    cachedList = null;
    lastPushedJson = null;

    if (!user) {
      notifyUpdate();
      scheduleAuthUiAfterNullUser();
      return;
    }

    clearAuthNullUiTimer();
    notifyAuthUi(user);
    hydrateFromCloud(user.uid);
  }

  function init() {
    if (app) return;
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK not loaded; dictionary stays local only.');
      authUiFirstEventDone = true;
      notifyAuthUi(null);
      return;
    }
    try {
      app = firebase.app();
    } catch (_) {
      app = firebase.initializeApp(firebaseConfig);
    }
    try {
      if (firebaseConfig.measurementId && firebase.analytics) {
        firebase.analytics();
      }
    } catch (_) {}
    auth = firebase.auth();
    db = firebase.firestore();
    auth.onAuthStateChanged(onAuthStateChangedHandler);
  }

  function getDictionary() {
    if (currentUser) {
      if (cachedList !== null) return cachedList;
      return localGet();
    }
    return localGet();
  }

  function saveDictionary(list) {
    if (!Array.isArray(list)) return;
    localSet(list);
    if (currentUser) {
      cachedList = list;
      debouncedPush(currentUser.uid, list);
    }
  }

  function isSignedIn() {
    return !!currentUser;
  }

  function getCurrentUser() {
    return auth && auth.currentUser ? auth.currentUser : null;
  }

  function isFirebaseAvailable() {
    return !!auth;
  }

  function isLocalSessionSkip() {
    try {
      return sessionStorage.getItem(SESSION_SKIP_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function setLocalSessionSkip() {
    try {
      sessionStorage.setItem(SESSION_SKIP_KEY, '1');
    } catch (_) {}
  }

  function clearLocalSessionSkip() {
    try {
      sessionStorage.removeItem(SESSION_SKIP_KEY);
    } catch (_) {}
  }

  function signOutFully() {
    clearLocalSessionSkip();
    if (auth) {
      auth.signOut();
    }
  }

  function onAuthUiChange(fn) {
    authUiListeners.push(fn);
    if (authUiFirstEventDone) {
      fn(lastAuthUiUser);
    }
  }

  function onDictionaryUpdate(fn) {
    updateListeners.push(fn);
  }

  function bindAuthUI(opts) {
    var emailEl = opts.email;
    var passwordEl = opts.password;
    var signInBtn = opts.signIn;
    var signUpBtn = opts.signUp;
    var signOutBtn = opts.signOut;
    var loggedOutEl = opts.loggedOut;
    var loggedInEl = opts.loggedIn;
    var userEmailEl = opts.userEmail;
    var errorEl = opts.error;

    if (!auth) return;

    function showError(msg) {
      if (!errorEl) return;
      if (msg) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      } else {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    function refreshAuthUI() {
      var u = auth.currentUser;
      if (u) {
        if (loggedOutEl) loggedOutEl.hidden = true;
        if (loggedInEl) loggedInEl.hidden = false;
        if (userEmailEl) userEmailEl.textContent = u.email || u.uid;
      } else {
        if (loggedOutEl) loggedOutEl.hidden = false;
        if (loggedInEl) loggedInEl.hidden = true;
        if (userEmailEl) userEmailEl.textContent = '';
      }
      showError('');
    }

    auth.onAuthStateChanged(refreshAuthUI);
    refreshAuthUI();

    if (signInBtn) {
      signInBtn.addEventListener('click', function () {
        showError('');
        var email = (emailEl && emailEl.value) || '';
        email = email.trim();
        var password = (passwordEl && passwordEl.value) || '';
        if (!email || !password) {
          showError('Enter email and password.');
          return;
        }
        auth.signInWithEmailAndPassword(email, password).catch(function (e) {
          showError(e.message || 'Sign in failed');
        });
      });
    }

    if (signUpBtn) {
      signUpBtn.addEventListener('click', function () {
        showError('');
        var email = (emailEl && emailEl.value) || '';
        email = email.trim();
        var password = (passwordEl && passwordEl.value) || '';
        if (!email || !password) {
          showError('Enter email and password.');
          return;
        }
        if (password.length < 6) {
          showError('Password must be at least 6 characters.');
          return;
        }
        auth.createUserWithEmailAndPassword(email, password).catch(function (e) {
          showError(e.message || 'Sign up failed');
        });
      });
    }

    if (signOutBtn) {
      signOutBtn.addEventListener('click', function () {
        signOutFully();
      });
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && currentUser && cachedList !== null) {
      clearTimeout(saveTimer);
      flushPush(currentUser.uid, cachedList);
    }
  });

  global.DictionaryFirebase = {
    init: init,
    getDictionary: getDictionary,
    saveDictionary: saveDictionary,
    isSignedIn: isSignedIn,
    getCurrentUser: getCurrentUser,
    isFirebaseAvailable: isFirebaseAvailable,
    isLocalSessionSkip: isLocalSessionSkip,
    setLocalSessionSkip: setLocalSessionSkip,
    signOutFully: signOutFully,
    onAuthUiChange: onAuthUiChange,
    onDictionaryUpdate: onDictionaryUpdate,
    bindAuthUI: bindAuthUI
  };

  init();
})(typeof window !== 'undefined' ? window : globalThis);
