// auth.js — optional customer accounts (email + password via Supabase Auth).
//
// Loaded by index.html AFTER the inline script that creates `supabaseClient`;
// this file relies on that global. Guest ordering is unaffected: if this file
// ever fails to load, the order form still works, orders just get user_id = null.
//
// Flow with "Confirm email" ON (the Supabase default):
//   sign up -> Supabase emails a confirmation link -> user clicks it ->
//   lands back on the project's Site URL already logged in (supabase-js reads
//   the tokens from the URL hash and fires onAuthStateChange with SIGNED_IN).

(function () {
    var dialog    = document.getElementById("authDialog");
    var form      = document.getElementById("authForm");
    var titleEl   = document.getElementById("authTitle");
    var emailEl   = document.getElementById("authEmail");
    var passEl    = document.getElementById("authPassword");
    var submitBtn = document.getElementById("authSubmitBtn");
    var switchBtn = document.getElementById("authSwitchBtn");
    var forgotBtn = document.getElementById("authForgotBtn");
    var msgEl     = document.getElementById("authMessage");
    var openBtn   = document.getElementById("accountBtn");
    var closeBtn  = document.getElementById("authCloseBtn");
    var logoutBtn = document.getElementById("logoutBtn");
    var ordersLnk = document.getElementById("myOrdersLink");
    var statusEl  = document.getElementById("accountStatus");

    var mode = "login"; // "login" | "signup" | "forgot" | "recovery"

    // If the user arrived via an expired/invalid confirmation link, Supabase puts the
    // reason in the URL hash (#error_description=...). Shown in the header until the
    // user opens the login box. (Signing up again with the same email re-sends the link.)
    var linkError = new URLSearchParams(window.location.hash.slice(1)).get("error_description") || "";
    if (linkError) linkError += ". Try logging in, or sign up again to get a fresh link.";

    // <dialog> is supported by every current browser. The fallback only matters on
    // very old Android WebViews: it shows the box inline (non-modal) instead.
    function openDialog() {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
    }
    function closeDialog() {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
    }

    function showMsg(text, isError) {
        msgEl.textContent = text;
        msgEl.classList.toggle("error", !!isError);
    }

    function setMode(next) {
        mode = next;
        var labels = {
            login:    { title: "Log in",          submit: "Log in",          swap: "New here? Create an account" },
            signup:   { title: "Create account",  submit: "Create account",  swap: "Already have an account? Log in" },
            forgot:   { title: "Reset password",  submit: "Send reset link", swap: "Back to log in" },
            recovery: { title: "Choose a new password", submit: "Save new password", swap: "" }
        }[mode];
        titleEl.textContent   = labels.title;
        submitBtn.textContent = labels.submit;
        switchBtn.textContent = labels.swap;
        switchBtn.classList.toggle("hidden", !labels.swap);
        // forgot: only the email is needed. recovery: only the new password.
        emailEl.parentNode.classList.toggle("hidden", mode === "recovery");
        passEl.parentNode.classList.toggle("hidden", mode === "forgot");
        emailEl.required = mode !== "recovery";
        passEl.required  = mode !== "forgot";
        passEl.setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
        forgotBtn.classList.toggle("hidden", mode !== "login");
        showMsg("");
    }

    function renderAuthState(session) {
        if (session) {
            statusEl.textContent = "Logged in as " + session.user.email;
            openBtn.classList.add("hidden");
            ordersLnk.classList.remove("hidden");
            logoutBtn.classList.remove("hidden");
        } else {
            statusEl.textContent = linkError;
            openBtn.classList.remove("hidden");
            ordersLnk.classList.add("hidden");
            logoutBtn.classList.add("hidden");
        }
    }

    // Single source of truth for "who is logged in". Fires INITIAL_SESSION on page
    // load (including right after the email-confirmation redirect), then
    // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED as things change.
    supabaseClient.auth.onAuthStateChange(function (event, session) {
        renderAuthState(session);
        if (event === "PASSWORD_RECOVERY") {
            // User arrived from the reset-password email. They are logged in via the
            // link, but should not do anything else until they've set a new password.
            setMode("recovery");
            openDialog();
            passEl.focus();
            return;
        }
        if (event === "SIGNED_IN" && dialog.hasAttribute("open") && mode !== "recovery") closeDialog();
    });

    openBtn.addEventListener("click", function () {
        linkError = "";
        statusEl.textContent = "";
        setMode("login");
        openDialog();
        emailEl.focus();
    });
    closeBtn.addEventListener("click", closeDialog);
    switchBtn.addEventListener("click", function () {
        setMode(mode === "login" ? "signup" : "login");
    });
    forgotBtn.addEventListener("click", function () {
        setMode("forgot");
        emailEl.focus();
    });

    logoutBtn.addEventListener("click", async function () {
        logoutBtn.disabled = true;
        var res = await supabaseClient.auth.signOut();
        logoutBtn.disabled = false;
        if (res.error) console.error("Sign out error:", res.error);
        // The header updates via the SIGNED_OUT event above.
    });

    form.addEventListener("submit", async function (e) {
        e.preventDefault();
        var email = emailEl.value.trim();
        var password = passEl.value;
        if (mode === "forgot" ? !email : mode === "recovery" ? !password : (!email || !password)) {
            showMsg("Please fill in the field above.", true);
            return;
        }
        submitBtn.disabled = true;
        showMsg({ signup: "Creating your account…", forgot: "Sending…", recovery: "Saving…" }[mode] || "Logging in…");
        try {
            if (mode === "forgot") {
                var reset = await supabaseClient.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + window.location.pathname
                });
                if (reset.error) { showMsg(reset.error.message, true); return; }
                // Supabase returns success even for unknown emails (prevents enumeration).
                showMsg("If an account exists for " + email + ", a reset link is on its way. Open it on this device, then choose a new password.");
            } else if (mode === "recovery") {
                var upd = await supabaseClient.auth.updateUser({ password: password });
                if (upd.error) { showMsg(upd.error.message, true); return; }
                passEl.value = "";
                closeDialog();
                setMode("login");
                statusEl.textContent = "Password updated. You're logged in as " + upd.data.user.email;
            } else if (mode === "login") {
                var login = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
                if (login.error) { showMsg(login.error.message, true); return; }
                showMsg("");
                // The dialog closes via the SIGNED_IN event above.
            } else {
                var signup = await supabaseClient.auth.signUp({ email: email, password: password });
                if (signup.error) { showMsg(signup.error.message, true); return; }
                var user = signup.data.user;
                // With "Confirm email" ON, Supabase deliberately does NOT return an error
                // for an already-registered address (prevents email enumeration). It returns
                // a placeholder user whose identities array is empty instead.
                if (user && user.identities && user.identities.length === 0) {
                    showMsg("That email is already registered. Try logging in instead.", true);
                    return;
                }
                if (signup.data.session) {
                    showMsg(""); // "Confirm email" is OFF: logged in immediately.
                } else {
                    passEl.value = "";
                    showMsg("Almost done. We sent a confirmation link to " + email +
                            ". Open it to activate your account; you'll be logged in here automatically.");
                }
            }
        } catch (err) {
            console.error("Auth error:", err);
            showMsg("Something went wrong. Please try again.", true);
        } finally {
            submitBtn.disabled = false;
        }
    });
})();
