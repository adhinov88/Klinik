const form = document.getElementById('registration-form');
const resultBox = document.getElementById('result');
const visitDateInput = document.querySelector('.date-picker');
const birthDateInput = document.querySelector('.birth-date');
const submitButton = document.getElementById('submit-button');
const submitText = submitButton ? submitButton.querySelector('.btn-text') : null;

function setSubmitting(isSubmitting) {
  if (!submitButton || !submitText) return;
  submitButton.disabled = isSubmitting;
  submitButton.classList.toggle('is-loading', isSubmitting);
  submitText.textContent = isSubmitting ? 'Proses....' : 'Dapatkan Nomor Antrean';
}

function showResult(message, type = 'success') {
  resultBox.textContent = message;
  resultBox.className = `result ${type}`;
  resultBox.classList.remove('hidden');
}

function formatDateDisplay(value) {
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function getJakartaTodayDmy() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date());
  const day = parts.find((p) => p.type === 'day')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const year = parts.find((p) => p.type === 'year')?.value;
  return `${day}/${month}/${year}`;
}

function setVisitDateToday() {
  if (!visitDateInput) return;
  visitDateInput.value = getJakartaTodayDmy();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resultBox.classList.add('hidden');

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  if (birthDateInput) {
    payload.birthDate = formatBirthDate(birthDateInput.value);
  }

  if (!payload.fullName || !payload.phone || !payload.email) {
    showResult('Nama lengkap, nomor HP, dan email wajib diisi.', 'error');
    return;
  }

  setSubmitting(true);

  try {
    const response = await fetch('/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      showResult(data.error || 'Pendaftaran gagal. Silakan coba lagi.', 'error');
      return;
    }

    const displayDate = formatDateDisplay(data.queueDate);
    showResult(
      `Pendaftaran berhasil. Nomor antrean Anda: ${data.queueNumber} (Tanggal ${displayDate}). Silahkan cek email Anda.`,
      'success'
    );
    form.reset();
    setVisitDateToday();
  } catch (error) {
    showResult('Terjadi gangguan koneksi. Silakan coba lagi.', 'error');
  } finally {
    setSubmitting(false);
  }
});

if (window.flatpickr && visitDateInput) {
  window.flatpickr(visitDateInput, {
    dateFormat: 'd/m/Y',
    allowInput: false,
    disableMobile: true,
    locale: 'id',
    defaultDate: getJakartaTodayDmy(),
    clickOpens: false,
  });
}

setVisitDateToday();

function formatBirthDate(value) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}


if (birthDateInput) {
  birthDateInput.addEventListener('input', (event) => {
    const formatted = formatBirthDate(event.target.value);
    event.target.value = formatted;
  });
}
