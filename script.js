
// TOWER BG website

console.log("Welcome to TOWER BG!");

// Плавно придвижване по менюто
document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', function(event) {
        const target = this.getAttribute('href');

        if (target === '#') {
            event.preventDefault();
            return;
        }

        const section = document.querySelector(target);

        if (section) {
            event.preventDefault();
            section.scrollIntoView({
                behavior: 'smooth'
            });
        }
    });
});

// Discord бутонът засега е без покана

const supportForm = document.getElementById("supportForm");

if (supportForm) {
    const email = document.getElementById("email");
    const confirmEmail = document.getElementById("confirmEmail");

    supportForm.addEventListener("submit", function(event) {
        if (email.value.trim() !== confirmEmail.value.trim()) {
            event.preventDefault();
            confirmEmail.setCustomValidity("Имейлите не съвпадат!");
            confirmEmail.reportValidity();
        } else {
            confirmEmail.setCustomValidity("");
        }
    });

    confirmEmail.addEventListener("input", function() {
        confirmEmail.setCustomValidity("");
    });
}

