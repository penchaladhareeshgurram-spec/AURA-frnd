import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  projectId: "gen-lang-client-0696833917",
  appId: "1:703946782697:web:80b35b467578d92e09fd78",
  apiKey: "AIzaSyDb7lktamZgGH4YPEzEJ9nwckBNmj6uQK8",
  authDomain: "gen-lang-client-0696833917.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-edd1952f-8d4f-49db-a110-6ace84dfa7ff",
  storageBucket: "gen-lang-client-0696833917.firebasestorage.app",
  messagingSenderId: "703946782697",
  measurementId: ""
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = async () => {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    console.error("Error signing in with Google", error);
    throw error;
  }
};

export const logOut = async () => {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error signing out", error);
    throw error; // Let the caller handle the error
  }
};
