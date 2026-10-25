/* =========================================================================
   firebase-config.js
   -------------------------------------------------------------------------
   Paste your Firebase web config here when we wire the backend.
   Firebase console → Project settings → "Your apps" → SDK setup → Config.

   Until apiKey + projectId are filled in, Lustre runs in DEMO mode:
   a fully interactive, offline preview with sample conversations so you
   can see and feel the UI. Nothing is saved anywhere in demo mode.
   ========================================================================= */

export const firebaseConfig = {
  apiKey: "AIzaSyAoJeoF5G_jXXlnq6Tu_zjOaq5Ia5jN89s",
  authDomain: "lustre-d4d6d.firebaseapp.com",
  projectId: "lustre-d4d6d",
  storageBucket: "lustre-d4d6d.firebasestorage.app",
  messagingSenderId: "596521117770",
  appId: "1:596521117770:web:e752d332be0b72d85b1eb3",
  measurementId: "G-7CQQDKEY0C",
};

export const isConfigured = () =>
  !!firebaseConfig.apiKey && !!firebaseConfig.projectId;
