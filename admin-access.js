export function showAdminFeedbackIfAllowed(user, userData) {
  const btn = document.getElementById("adminFeedbackBtn");
  if (!btn) return;

  const email = (user?.email || "").toLowerCase();

  const isAdmin =
    userData?.role === "admin" ||
    userData?.developerAccess === true ||
    email === "s.dumas974@gmail.com" ||
    email === "contact@axe-dossier.fr";

  btn.style.display = isAdmin ? "inline-flex" : "none";
}
