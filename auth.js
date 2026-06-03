import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

import { auth } from "./firebase-config.js";

window.loginUser = async function(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = "tableau-de-bord.html";
  } catch(error) {
    alert(error.message);
  }
};

window.registerUser = async function(email, password) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    window.location.href = "tableau-de-bord.html";
  } catch(error) {
    alert(error.message);
  }
};

window.logoutUser = async function() {
  await signOut(auth);
  window.location.href = "connexion.html";
};

window.checkAuth = function() {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "connexion.html";
    }
  });
};
