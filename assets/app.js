/* LaunchWise funnel — 4-step questionnaire, checklist, lead form */
(function () {
  'use strict';

  var TOTAL_STEPS = 4;
  var state = {
    step: 1,
    stage: '',
    industry: '',
    employees: 'Just me',
    revenue: 'Pre-revenue',
    state: 'CA',
    timeline: 'ASAP',
    interests: [],
    sessionId: null
  };

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  var funnel = $('#funnel');
  var progressBar = $('#progressBar');
  var stepLabel = $('#stepLabel');
  var backBtn = $('#backBtn');
  var nextBtn = $('#nextBtn');
  var quizError = $('#quizError');

  // ---------- GA4 event helper ----------
  function track(name, params) {
    if (typeof gtag === 'function') gtag('event', name, params || {});
  }
  track('funnel_view');

  // ---------- Option (single-select) buttons ----------
  $$('.options').forEach(function (group) {
    var name = group.dataset.name;
    $$('.option', group).forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.option', group).forEach(function (b) { b.classList.remove('selected'); });
        btn.classList.add('selected');
        state[name] = btn.dataset.value;
        nextBtn.disabled = false;
        quizError.textContent = '';
      });
    });
  });

  // ---------- Chip (multi-select) buttons ----------
  $$('.chips').forEach(function (group) {
    $$('.chip', group).forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.classList.toggle('selected');
        if (group.dataset.name === 'insurance_interests') {
          state.interests = $$('.chip.selected', group).map(function (b) { return b.dataset.value; });
          nextBtn.disabled = false; // step 4 is optional — always allowed
        }
      });
    });
  });

  // ---------- Step navigation ----------
  function showStep(n) {
    state.step = n;
    $$('.step').forEach(function (fs) {
      fs.classList.toggle('hidden', parseInt(fs.dataset.step, 10) !== n);
    });
    progressBar.style.width = (n / TOTAL_STEPS * 100) + '%';
    stepLabel.textContent = 'Step ' + n + ' of ' + TOTAL_STEPS;
    backBtn.classList.toggle('hidden', n === 1);
    nextBtn.textContent = n === TOTAL_STEPS ? 'Build my checklist' : 'Continue';

    // Steps 1 & 2 require a selection; 3 & 4 are always valid.
    var needsPick = (n === 1 && !state.stage) || (n === 2 && !state.industry);
    nextBtn.disabled = needsPick;
    quizError.textContent = '';
    track('funnel_step_view', { step: n });
  }

  backBtn.addEventListener('click', function () { if (state.step > 1) showStep(state.step - 1); });

  nextBtn.addEventListener('click', function () {
    if (state.step === 1 && !state.stage) { quizError.textContent = 'Please pick one option to continue.'; return; }
    if (state.step === 2 && !state.industry) { quizError.textContent = 'Please pick a business type to continue.'; return; }
    if (state.step < TOTAL_STEPS) { showStep(state.step + 1); return; }
    finishQuiz();
  });

  // ---------- Finish: save + build checklist ----------
  function finishQuiz() {
    state.employees = $('select[name=employees]').value;
    state.revenue = $('select[name=revenue]').value;
    state.state = $('select[name=state]').value;
    state.timeline = $('select[name=timeline]').value;

    var fd = new FormData();
    fd.append('action', 'questionnaire');
    fd.append('stage', state.stage);
    fd.append('industry', state.industry);
    fd.append('employees', state.employees);
    fd.append('revenue', state.revenue);
    fd.append('state', state.state);
    fd.append('timeline', state.timeline);
    state.interests.forEach(function (v) { fd.append('insurance_interests', v); });

    nextBtn.disabled = true;
    fetch('/api/questionnaire', { method: 'POST', body: new URLSearchParams(fd) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) state.sessionId = res.session_id;
      })
      .catch(function () { /* checklist still renders if save fails */ })
      .finally(function () {
        $('#leadSessionId').value = state.sessionId || '';
        renderChecklist();
        funnel.classList.add('hidden');
        $('#checklistSection').classList.remove('hidden');
        $('#checklistSection').scrollIntoView({ behavior: 'smooth' });
        track('checklist_generated', { industry: state.industry, state: state.state });
      });
  }

  // ---------- Personalized checklist rules ----------
  function buildChecklist() {
    var items = [];
    var s = state;

    if (s.stage === 'Just exploring' || s.stage === 'Ready to form LLC') {
      items.push('Choose a business name and check its availability with the ' + s.state + ' Secretary of State.');
      items.push('Decide your LLC management structure (member-managed vs. manager-managed).');
      items.push('File Articles of Organization in ' + s.state + ' and pay the state filing fee.');
      items.push('Designate a registered agent with a physical address in ' + s.state + '.');
      items.push('Draft an Operating Agreement — even single-member LLCs benefit from one.');
      items.push('Get a free EIN from the IRS (irs.gov) for taxes and banking.');
      items.push('Open a dedicated business bank account to keep finances separate.');
      items.push('Check local business license and permit requirements for your city/county and industry.');
    } else if (s.stage === 'LLC already formed') {
      items.push('Confirm your ' + s.state + ' LLC is in good standing and annual reports are current.');
      items.push('Review or create your Operating Agreement if ownership or roles have changed.');
      items.push('Verify you have an EIN and a separate business bank account.');
      items.push('Check whether you need to foreign-qualify in other states where you do business.');
      items.push('Review your licenses/permits — renewals often lapse unnoticed.');
    } else { // Operating without LLC
      items.push('Consider forming an LLC in ' + s.state + ' to separate personal and business liability.');
      items.push('Until you form one, know that as a sole proprietor you are personally liable for business debts.');
      items.push('Get an EIN and open a separate business bank account as an interim step.');
      items.push('Track income/expenses now — it makes the eventual transition and taxes easier.');
    }

    // Industry-specific
    var byIndustry = {
      'Professional services': 'Look into professional liability (E&O) insurance and any professional licensing in your field.',
      'E-commerce / retail': 'Review sales-tax registration obligations in states where you have nexus, plus product liability coverage.',
      'Food / hospitality': 'Confirm health department permits, food handler certifications, and liquor licensing if applicable.',
      'Construction / trades': "Verify contractor licensing in " + s.state + " and look into workers' compensation — often required even with one employee.",
      'Health / wellness': 'Check professional licensing, malpractice coverage, and privacy (HIPAA) obligations if you handle health data.',
      'Tech / online': 'Consider cyber liability coverage and review data-privacy laws that apply to your users.',
      'Other': 'Research industry-specific licensing and insurance requirements in ' + s.state + '.'
    };
    items.push(byIndustry[s.industry] || byIndustry.Other);

    if (s.employees !== 'Just me') {
      items.push("With employees, workers' compensation insurance is required in most states — verify " + s.state + " rules.");
      items.push('Register for state payroll/unemployment tax accounts before your first hire.');
    }
    if (s.revenue === '$500k+') {
      items.push('At your revenue level, talk to a CPA about S-corp election and quarterly estimated taxes.');
    }

    // Insurance interests
    if (s.interests.length) {
      items.push('You flagged interest in: ' + s.interests.join(', ') + '. Compare quotes from at least 2–3 licensed providers before buying.');
    }

    items.push('Calendar your ' + s.state + ' annual report deadline and set a reminder.');
    return items;
  }

  function renderChecklist() {
    var items = buildChecklist();
    $('#checklistIntro').textContent =
      'Based on your answers — ' + state.stage.toLowerCase() + ', ' +
      state.industry.toLowerCase() + ', launching in ' + state.state +
      ' (' + state.timeline.toLowerCase() + '):';
    var ul = $('#checklistItems');
    ul.innerHTML = '';
    items.forEach(function (text, i) {
      var li = document.createElement('li');
      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      var p = document.createElement('span');
      p.textContent = text;
      li.appendChild(num); li.appendChild(p);
      ul.appendChild(li);
    });
  }

  $('#restartBtn').addEventListener('click', function () { location.reload(); });
  $('#toLeadBtn').addEventListener('click', function () { track('lead_form_click'); });

  // ---------- Lead form ----------
  var leadForm = $('#leadForm');
  var leadError = $('#leadError');
  var leadSuccess = $('#leadSuccess');
  var leadSubmit = $('#leadSubmit');

  // Pre-select coverages chosen in step 4
  var leadChips = $$('.chips[data-name=coverage_types] .chip');
  function syncCoveragePreselect() {
    leadChips.forEach(function (c) {
      if (state.interests.indexOf(c.dataset.value) !== -1) c.classList.add('selected');
    });
  }

  leadForm.addEventListener('submit', function (e) {
    e.preventDefault();
    leadError.textContent = '';
    leadSuccess.classList.add('hidden');

    if (!leadForm.first_name.value.trim()) { leadError.textContent = 'Please enter your first name.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadForm.email.value.trim())) { leadError.textContent = 'Please enter a valid email address.'; return; }
    if (!leadForm.consent_contact.checked || !leadForm.consent_tcpa.checked) {
      leadError.textContent = 'Please check both consent boxes so we can contact you.'; return;
    }

    var fd = new FormData(leadForm);
    fd.append('action', 'insurance_lead');
    leadChips.forEach(function (c) {
      if (c.classList.contains('selected')) fd.append('coverage_types', c.dataset.value);
    });

    leadSubmit.disabled = true;
    fetch('/api/lead', { method: 'POST', body: new URLSearchParams(fd) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          leadForm.reset();
          leadChips.forEach(function (c) { c.classList.remove('selected'); });
          leadSuccess.classList.remove('hidden');
          track('generate_lead', { lead_id: res.lead_id });
        } else {
          leadError.textContent = res.error || 'Something went wrong. Please try again.';
        }
      })
      .catch(function () { leadError.textContent = 'Network error. Please try again.'; })
      .finally(function () { leadSubmit.disabled = false; });
  });

  // Keep lead chip preselection fresh when checklist is generated
  var origRender = renderChecklist;
  renderChecklist = function () { origRender(); syncCoveragePreselect(); };

  showStep(1);
})();
