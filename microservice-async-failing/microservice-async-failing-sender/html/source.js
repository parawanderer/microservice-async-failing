const modal = new bootstrap.Modal(document.getElementById("submittedModal"));

if (window.location.hash === "#success") {
    modal.show();
}

const submitButton = document.getElementById("button-submit");

const inputField = document.getElementById("order-input");
inputField.value = "";

inputField.addEventListener("input", (event) => {
    if (event.target.value && event.target.value.trim()) {
        submitButton.disabled = false;
    } else {
        submitButton.disabled = true;
    }
});

submitButton.addEventListener("submit", (event) => {
    if (inputField.value && inputField.value.trim()) {

    } else {
        event.preventDefault();
    }
});