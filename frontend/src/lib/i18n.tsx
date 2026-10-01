/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from "react";

export type Language = "en" | "ru";

const STORAGE_KEY = "tbb.language";

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch { /* private browsing */ }
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let currentLanguage: Language = initialLanguage();
document.documentElement.lang = currentLanguage;

export function getLanguage(): Language { return currentLanguage; }

const russian: Record<string, string> = {
  "Language": "Язык",
  "English": "English",
  "Russian": "Русский",
  "Switch to light theme": "Включить светлую тему",
  "Switch to dark theme": "Включить тёмную тему",
  "Light theme": "Светлая тема",
  "Dark theme": "Тёмная тема",
  "Account": "Аккаунт",
  "Sign out": "Выйти",
  "Loading": "Загрузка",
  "Your teams": "Ваши группы",
  "Everyone you split costs with.": "Все, с кем вы делите расходы.",
  "You owe nothing": "Вы никому не должны",
  "You owe {amount}": "Вы должны {amount}",
  "New team": "Новая группа",
  "Team name": "Название группы",
  "Flat 42": "Квартира 42",
  "A flat, a trip, a household — whatever you share.": "Квартира, поездка или дом — любые общие расходы.",
  "Currency": "Валюта",
  "Everything in this team is tracked in one currency.": "Все расходы группы учитываются в одной валюте.",
  "Create team": "Создать группу",
  "Cancel": "Отмена",
  "All settled": "Всё оплачено",
  "you are owed": "вам должны",
  "you owe": "вы должны",
  "person": "человек",
  "people": "человек",
  "Could not load your teams.": "Не удалось загрузить группы.",
  "No teams yet": "Пока нет групп",
  "Create one for your flat, then send the invite link to the people you live with. Everything you add gets split between whoever was actually in on it.": "Создайте группу и отправьте ссылку участникам. Каждый расход будет разделён только между теми, кто в нём участвует.",
  "Create your first team": "Создать первую группу",
  "Balances": "Балансы",
  "Expenses": "Расходы",
  "People": "Участники",
  "Team sections": "Разделы группы",
  "All teams": "Все группы",
  "This team does not exist, or you are not a member of it.": "Группа не существует или вы не её участник.",
  "Could not load this team.": "Не удалось загрузить группу.",
  "Add expense": "Добавить расход",
  "Where everyone stands": "Баланс участников",
  "{amount} spent in total": "Всего потрачено {amount}",
  "Settle up": "Расчёты",
  "Nothing outstanding.": "Долгов нет.",
  "{count} payment clears every debt in this team.": "Для погашения всех долгов нужен {count} перевод.",
  "{count} payments clear every debt in this team.": "Для погашения всех долгов нужно {count} переводов.",
  "{from} paid {to}": "{from} заплатил(а) {to}",
  "Undo": "Отменить",
  "Everyone is square. Nice.": "Все рассчитались.",
  "You": "Вы",
  "Someone": "Кто-то",
  "pay": "платите",
  "pays": "платит",
  "Mark paid": "Отметить оплачено",
  "Settled up": "Расчёт выполнен",
  "Spending by category": "Расходы по категориям",
  "Nothing spent yet": "Пока нет расходов",
  "Add an expense and the breakdown appears here.": "Добавьте расход, и здесь появится разбивка.",
  "Search expenses": "Поиск расходов",
  "Nothing matched": "Ничего не найдено",
  "No expenses yet": "Пока нет расходов",
  "Upcoming purchases": "Планируемые покупки",
  "Shopping lists stay out of balances until purchased.": "Списки покупок не влияют на баланс до оплаты.",
  "New plan": "Новый план",
  "Could not load plans.": "Не удалось загрузить планы покупок.",
  "Nothing planned yet. Add a shopping list when you know what to buy.": "Пока ничего не запланировано. Составьте список покупок.",
  "planned": "запланировано",
  "Try a different word, or clear the search.": "Попробуйте другое слово или очистите поиск.",
  "Add the first one. Type the lines or photograph a receipt.": "Добавьте первый расход: введите позиции вручную или сфотографируйте чек.",
  "You paid": "Вы оплатили",
  "{name} paid": "Оплатил(а) {name}",
  "{count} items": "Позиций: {count}",
  "scanned": "по чеку",
  "you are not on this one": "вы не участвуете",
  "your share": "ваша доля",
  "you": "вы",
  "owner": "владелец",
  "Invite links": "Ссылки-приглашения",
  "New link": "Новая ссылка",
  "Anyone with an active link can join this team. Links expire after 14 days.": "По активной ссылке можно присоединиться к группе. Ссылки действуют 14 дней.",
  "No active links. Create one to add someone.": "Активных ссылок нет. Создайте ссылку для приглашения.",
  "No active links right now.": "Сейчас активных ссылок нет.",
  "Leave this team": "Покинуть группу",
  "You can only leave once your balance is zero, so nobody inherits your share.": "Покинуть группу можно, когда ваш баланс равен нулю.",
  "Leave {name}": "Покинуть {name}",
  "Copy this invite link": "Скопируйте ссылку-приглашение",
  "Join {name}": "Присоединиться к {name}",
  "Join {name} to split costs": "Присоединиться к {name}, чтобы делить расходы",
  "expired": "истекла",
  "Share": "Поделиться",
  "Copied": "Скопировано",
  "Copy": "Копировать",
  "Revoke": "Отозвать",
  "Join a team": "Присоединиться к группе",
  "This invite link could not be checked.": "Не удалось проверить ссылку-приглашение.",
  "You have been invited to": "Вас пригласили в группу",
  "settles in": "расчёты в",
  "Join team": "Присоединиться",
  "Welcome back": "С возвращением",
  "Sign in to see what your flat owes you.": "Войдите, чтобы увидеть свои расчёты.",
  "Email": "Эл. почта",
  "Password": "Пароль",
  "Sign in": "Войти",
  "No account yet?": "Ещё нет аккаунта?",
  "Create one": "Создать",
  "Create an account": "Создать аккаунт",
  "Then invite the people you live with.": "Затем пригласите тех, с кем делите расходы.",
  "Your name": "Ваше имя",
  "This is how your flatmates will see you.": "Так вас будут видеть другие участники.",
  "At least {count} characters.": "Не менее {count} символов.",
  "Use at least {count} characters.": "Введите не менее {count} символов.",
  "Create account": "Создать аккаунт",
  "Already have one?": "Уже есть аккаунт?",
  "Could not reach the server.": "Не удалось связаться с сервером.",
  "email or password is incorrect": "Неверная почта или пароль",
  "that email is already registered": "Эта почта уже зарегистрирована",
  "the payer is not in this team": "Плательщик не состоит в группе",
  "receipt not found": "Чек не найден",
  "no line items found in this receipt": "Не удалось найти позиции в чеке",
  "Could not read this photo.": "Не удалось прочитать фото.",
  "expense not found": "Расход не найден",
  "That did not work": "Не получилось",
  "Try again": "Попробовать снова",
  "owed to them": "им должны",
  "they owe": "они должны",
  "owes": "должен",
  "settled": "расчёт",
  "is owed": "ему должны",
  "{share}% of all spending": "{share}% всех расходов",
  "Give it a name.": "Укажите название расхода.",
  "Add at least one line.": "Добавьте хотя бы одну позицию.",
  "Every line needs a name.": "У каждой позиции должно быть название.",
  "Every line needs an amount.": "У каждой позиции должна быть цена.",
  "Every line needs at least one person on it.": "Для каждой позиции выберите хотя бы одного участника.",
  "Save changes": "Сохранить изменения",
  "Edit expense": "Редактировать расход",
  "Add an expense": "Добавить расход",
  "Plan a purchase": "Запланировать покупку",
  "Edit plan": "Редактировать план",
  "Create plan": "Создать план",
  "Save plan": "Сохранить план",
  "Complete purchase": "Завершить покупку",
  "Record purchase": "Записать расход",
  "Fill in the prices and choose who shares each item.": "Укажите цены и участников для каждой позиции.",
  "Add what you intend to buy. Prices can wait until you purchase it.": "Добавьте нужные товары. Цены можно указать после покупки.",
  "What are you planning?": "Что планируете купить?",
  "Shopping list": "Список покупок",
  "Optional price": "Цена, необязательно",
  "Optional": "Необязательно",
  "Could not load this plan.": "Не удалось загрузить план покупок.",
  "Delete this plan?": "Удалить этот план?",
  "Delete plan": "Удалить план",
  "plan not found": "План покупок не найден",
  "unknown category": "Неизвестная категория",
  "names cannot be blank": "Укажите название плана и каждой позиции",
  "Scan a receipt": "Сканировать чек",
  "Add from receipt": "Добавить из чека",
  "Upload photos on a computer, or take a photo on your phone.": "Загрузите фото на компьютере или сфотографируйте чек на телефоне.",
  "Receipt scanning is not configured on this server.": "Распознавание чеков ещё не настроено на сервере.",
  "Scanned lines will be added to the ones already here.": "Позиции из чека добавятся к уже введённым.",
  "Upload, drop, or paste receipt photos. On a phone, you can also take a photo.": "Загрузите, перетащите или вставьте фото чека. На телефоне можно также сделать фото.",
  "Only image files can be added.": "Можно добавлять только изображения.",
  "Each photo must be {size} MB or smaller.": "Размер каждого фото должен быть не больше {size} МБ.",
  "You can add up to {count} photos.": "Можно добавить не больше {count} фото.",
  "Copy a photo first, then paste it here.": "Сначала скопируйте фото, затем вставьте его сюда.",
  "Drop receipt photos here": "Перетащите фото чека сюда",
  "Drop photos here, or paste with Ctrl+V / ⌘V.": "Перетащите фото сюда или вставьте через Ctrl+V / ⌘V.",
  "Copy a receipt photo, then tap Paste photo.": "Скопируйте фото чека и нажмите «Вставить фото».",
  "Paste photo": "Вставить фото",
  "Tap and hold in the field below and choose Paste, or press Ctrl+V / ⌘V. You can also choose a photo from your device.": "Нажмите и удерживайте поле ниже и выберите «Вставить» или нажмите Ctrl+V / ⌘V. Также можно выбрать фото на устройстве.",
  "Paste a receipt photo": "Вставить фото чека",
  "Upload photos": "Загрузить фото",
  "Choose from gallery": "Выбрать из галереи",
  "Photograph it, then split it line by line.": "Сфотографируйте чек и разделите позиции.",
  "What was it?": "Что купили?",
  "Weekly shop": "Покупки за неделю",
  "Who paid?": "Кто оплатил?",
  "When?": "Когда?",
  " (you)": " (вы)",
  "Each line is split equally between the people highlighted on it. Turn someone off a line and they pay nothing towards it.": "Каждая позиция делится поровну между отмеченными участниками. Снимите отметку, чтобы исключить участника из позиции.",
  "No lines yet. Add one by hand, or scan a receipt.": "Позиций пока нет. Добавьте вручную или отсканируйте чек.",
  "Item name": "Название позиции",
  "Item amount": "Цена позиции",
  "Name": "Название",
  "Price": "Цена",
  "Item": "Позиция",
  "Remove {name}": "Удалить {name}",
  "Add a line": "Добавить позицию",
  "Total": "Итого",
  "Category": "Категория",
  "Categories": "Категории",
  "Team categories": "Категории группы",
  "Everyone in this team can create and use these categories.": "Все участники группы могут создавать и использовать эти категории.",
  "No categories yet": "Категорий пока нет",
  "Create a category to organise this team's purchases.": "Создайте категорию для покупок этой группы.",
  "New category": "Новая категория",
  "Category name": "Название категории",
  "e.g. Pet supplies": "Например, товары для питомцев",
  "Emoji": "Эмодзи",
  "Create category": "Создать категорию",
  "Could not load categories.": "Не удалось загрузить категории.",
  "Could not create this category.": "Не удалось создать категорию.",
  "a category with that name already exists": "Категория с таким названием уже существует",
  "Optional, but it makes the breakdown useful.": "Необязательно, но поможет видеть структуру расходов.",
  "No category": "Без категории",
  "Note": "Заметка",
  "Anything worth remembering later.": "То, что стоит запомнить.",
  "Delete this expense? Balances will be recalculated.": "Удалить расход? Балансы будут пересчитаны.",
  "Delete expense": "Удалить расход",
  "Back": "Назад",
  "Queued…": "В очереди…",
  "Reading the receipt…": "Читаем чек…",
  "Uploading…": "Загрузка…",
  "Photograph the whole receipt. A long one can take several photos — add them in order. Every line comes back editable, so you can fix anything the model misread.": "Сфотографируйте чек целиком. Длинный чек можно снять по частям, по порядку. Все позиции затем можно исправить вручную.",
  "That receipt could not be read.": "Не удалось прочитать чек.",
  "Photo {count}": "Фото {count}",
  "Remove photo {count}": "Удалить фото {count}",
  "Add": "Добавить",
  "Read the receipt": "Распознать чек",
  "Take a photo": "Сделать фото",
  "Choose images": "Выбрать изображения",
  "From photos": "Из галереи",
  "Up to {count} images, {size} MB each": "До {count} изображений, каждое до {size} МБ",
  "Your session expired. Please sign in again.": "Сессия истекла. Войдите снова.",
  "Please sign in.": "Войдите в аккаунт.",
  "Something went wrong": "Произошла ошибка",
};

function interpolate(text: string, values?: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`));
}

export function translate(key: string, values?: Record<string, string | number>): string {
  return interpolate(currentLanguage === "ru" ? (russian[key] ?? key) : key, values);
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: typeof translate;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setState] = useState<Language>(currentLanguage);
  function setLanguage(next: Language) {
    currentLanguage = next;
    document.documentElement.lang = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private browsing */ }
    setState(next);
  }
  return <LanguageContext.Provider value={{ language, setLanguage, t: translate }}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LanguageProvider is missing");
  return context;
}


export function pluralRu(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function personWord(count: number, language: Language): string {
  return language === "ru"
    ? pluralRu(count, "человек", "человека", "человек")
    : count === 1 ? "person" : "people";
}
