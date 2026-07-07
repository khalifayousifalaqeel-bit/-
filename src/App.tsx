/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot,
  serverTimestamp,
  doc,
  updateDoc,
  deleteDoc,
  getDocFromServer
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from './firebase';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Activity, 
  LogOut, 
  LogIn, 
  Send, 
  History, 
  AlertCircle, 
  CheckCircle2, 
  Clock,
  Stethoscope,
  ChevronRight,
  Share2,
  Loader2,
  Thermometer,
  Usb,
  Trash2,
  ExternalLink,
  Camera,
  Image as ImageIcon,
  X,
  Eye,
  Zap,
  Brain,
  Wind,
  Droplets,
  Flame,
  Heart,
  Ear,
  Frown,
  ShieldAlert
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';

// --- Types ---
interface Analysis {
  possibleCondition: string;
  advice: string;
  urgency: 'low' | 'medium' | 'high';
  sources: string[];
}

interface Consultation {
  id: string;
  userId: string;
  symptoms: string;
  temperature?: string | null;
  imageUrl?: string | null;
  doctorNotes?: string | null;
  analysis: Analysis;
  sharedWithHospital: boolean;
  createdAt: any;
}

// --- Gemini Setup ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

// --- Helpers ---
const getSymptomIcons = (text: string) => {
  const icons = [];
  const lowerText = text.toLowerCase();

  const mappings = [
    { keywords: ['صداع', 'رأس', 'headache'], icon: Brain, color: 'text-purple-500' },
    { keywords: ['حمى', 'حرارة', 'سخونة', 'fever'], icon: Flame, color: 'text-orange-500' },
    { keywords: ['سعال', 'كحة', 'تنفس', 'صدري', 'cough', 'breath'], icon: Wind, color: 'text-blue-400' },
    { keywords: ['رشح', 'زكام', 'أنف', 'cold', 'flu'], icon: Droplets, color: 'text-sky-400' },
    { keywords: ['ألم', 'وجع', 'pain'], icon: Zap, color: 'text-amber-500' },
    { keywords: ['قلب', 'نبض', 'heart'], icon: Heart, color: 'text-red-500' },
    { keywords: ['تعب', 'إرهاق', 'خمول', 'fatigue'], icon: Frown, color: 'text-stone-500' },
    { keywords: ['أذن', 'سمع', 'ear'], icon: Ear, color: 'text-yellow-600' },
    { keywords: ['عين', 'بصر', 'eye'], icon: Eye, color: 'text-indigo-500' },
    { keywords: ['معدة', 'بطن', '消化', 'stomach'], icon: Activity, color: 'text-emerald-500' },
    { keywords: ['جلد', 'حكة', 'جرح', 'skin', 'wound'], icon: ShieldAlert, color: 'text-rose-400' },
  ];

  mappings.forEach(m => {
    if (m.keywords.some(k => lowerText.includes(k))) {
      icons.push({ Icon: m.icon, color: m.color });
    }
  });

  return icons;
};

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [symptoms, setSymptoms] = useState('');
  const [temperature, setTemperature] = useState<string>('');
  const [ignoreTemperature, setIgnoreTemperature] = useState(false);
  const [readingUsb, setReadingUsb] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // --- Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login Error:", err);
      setError("فشل تسجيل الدخول. يرجى المحاولة مرة أخرى.");
    }
  };

  const logout = () => signOut(auth);

  const fileToGenerativePart = async (file: File) => {
    return new Promise<{ inlineData: { data: string; mimeType: string } }>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve({
          inlineData: { data: base64, mimeType: file.type },
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const compressImage = (file: File): Promise<File> => {
    return new Promise((resolve) => {
      const img = new globalThis.Image();
      const objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (blob) => {
              if (blob) {
                const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                  type: 'image/jpeg',
                  lastModified: Date.now(),
                });
                resolve(compressedFile);
              } else {
                resolve(file);
              }
            },
            'image/jpeg',
            0.7
          );
        } else {
          resolve(file);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(file);
      };
    });
  };

  const uploadImage = async (file: File, userId: string) => {
    const filename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const imageRef = ref(storage, `consultations/${userId}/${filename}`);
    const snapshot = await uploadBytes(imageRef, file);
    return getDownloadURL(snapshot.ref);
  };

  // --- Firestore Data ---
  useEffect(() => {
    if (!user) {
      setConsultations([]);
      return;
    }

    const q = query(
      collection(db, 'consultations'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Consultation[];
      setConsultations(data);
    }, (err) => {
      console.error("Firestore Error:", err);
      // If permission denied, it might be because the user document doesn't exist yet or rules are strict
    });

    return () => unsubscribe();
  }, [user]);

  // --- Connection Test ---
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    }
    testConnection();
  }, []);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        setError("حجم الصورة كبير جداً. يرجى اختيار صورة أقل من 5 ميجابايت.");
        return;
      }
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  // --- AI Analysis ---
  const analyzeSymptoms = async () => {
    if (!symptoms.trim() || !user) return;

    setAnalyzing(true);
    setAnalysisStep("جاري بدء التحليل...");
    setError(null);

    try {
      let imageUrl: string | null = null;
      const promptParts: any[] = [
        { 
          text: `حلل الأعراض التالية وقدم احتمال المرض الأقرب، نصائح أولية، وروابط لمصادر طبية موثوقة (مثل Mayo Clinic, NHS, WebMD).
          الأعراض: ${symptoms}
          ${temperature && !ignoreTemperature ? `درجة الحرارة المقاسة: ${temperature}°C` : ''}
          ${selectedImage ? "توجد صورة لـ (جرح/انتفاخ/تغير لون) مرفقة للتحليل." : ""}
          يجب أن يكون الرد بتنسيق JSON حصراً. يرجى تزويد روابط فعلية (URLs) للمصادر إذا أمكن.` 
        }
      ];

      if (selectedImage) {
        setAnalysisStep("جاري تحسين وضغط الصورة لتسريع التحليل...");
        const compressedImage = await compressImage(selectedImage);
        
        setAnalysisStep("جاري تحضير الصورة لنموذج الذكاء الاصطناعي...");
        const imagePart = await fileToGenerativePart(compressedImage);
        promptParts.push(imagePart);
        
        try {
          setAnalysisStep("جاري رفع الصورة بأمان للتخزين السحابي...");
          imageUrl = await uploadImage(compressedImage, user.uid);
        } catch (uploadError) {
          console.warn("Firebase Storage upload failed, proceeding with direct AI analysis fallback:", uploadError);
          // We intentionally do not crash. We can still run the AI analysis using base64 and save to db (without imageUrl)
        }
      }

      setAnalysisStep("جاري تشخيص الأعراض وتجهيز التقرير الطبي...");
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: promptParts,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              possibleCondition: { type: Type.STRING, description: "اسم الحالة المحتملة بالعربية" },
              advice: { type: Type.STRING, description: "نصائح طبية أولية بالعربية" },
              urgency: { type: Type.STRING, enum: ["low", "medium", "high"], description: "مدى الخطورة" },
              sources: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "قائمة بروابط (URLs) أو أسماء المصادر الطبية الموثوقة"
              }
            },
            required: ["possibleCondition", "advice", "urgency", "sources"]
          }
        }
      });

      setAnalysisStep("جاري حفظ التقرير الطبي في سجل الاستشارات...");
      const result = JSON.parse(response.text || '{}') as Analysis;

      await addDoc(collection(db, 'consultations'), {
        userId: user.uid,
        symptoms,
        temperature: (temperature && !ignoreTemperature) ? temperature : null,
        imageUrl,
        analysis: result,
        sharedWithHospital: false,
        createdAt: serverTimestamp()
      });

      setSymptoms('');
      setTemperature('');
      setSelectedImage(null);
      setImagePreview(null);
    } catch (err) {
      if (err instanceof Error && err.message.includes('permission')) {
        handleFirestoreError(err, OperationType.WRITE, 'consultations');
      }
      console.error("Analysis Error:", err);
      setError("حدث خطأ أثناء تحليل الأعراض. يرجى المحاولة مرة أخرى.");
    } finally {
      setAnalyzing(false);
      setAnalysisStep(null);
    }
  };

  const shareWithHospital = async (id: string) => {
    try {
      await updateDoc(doc(db, 'consultations', id), {
        sharedWithHospital: true
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `consultations/${id}`);
      console.error("Share Error:", err);
    }
  };

  const deleteConsultation = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'consultations', id));
      setDeletingId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `consultations/${id}`);
      console.error("Delete Error:", err);
    }
  };

  const simulateUsbReading = () => {
    setReadingUsb(true);
    // Simulate a delay for "reading" from USB
    setTimeout(() => {
      const randomTemp = (36.5 + Math.random() * 2.5).toFixed(1);
      setTemperature(randomTemp);
      setReadingUsb(false);
    }, 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFBF7]">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-stone-900 font-sans selection:bg-emerald-100" dir="rtl">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-stone-200">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-900/10">
              <Stethoscope className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-stone-800">مُساعِد صحتي الذكي</h1>
          </div>
          
          {user ? (
            <div className="flex items-center gap-4">
              <div className="hidden sm:block text-left">
                <p className="text-sm font-medium text-stone-700">{user.displayName}</p>
                <p className="text-xs text-stone-500">{user.email}</p>
              </div>
              <button 
                onClick={logout}
                className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500"
                title="تسجيل الخروج"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <button 
              onClick={login}
              className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-full font-medium hover:bg-red-700 transition-all shadow-md shadow-red-100"
            >
              <LogIn className="w-4 h-4" />
              <span>تسجيل الدخول</span>
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {!user ? (
          <div className="text-center py-20">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-md mx-auto"
            >
              <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <Activity className="w-10 h-10 text-emerald-600" />
              </div>
              <h2 className="text-3xl font-bold text-stone-800 mb-4">صحتك تبدأ من هنا</h2>
              <p className="text-stone-600 mb-8 leading-relaxed">
                سجل دخولك لتبدأ في تحليل أعراضك الصحية والحصول على نصائح ذكية من الذكاء الاصطناعي.
              </p>
              <button 
                onClick={login}
                className="w-full bg-emerald-600 text-white px-8 py-4 rounded-2xl font-bold text-lg hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-100 flex items-center justify-center gap-3"
              >
                <LogIn className="w-6 h-6" />
                <span>ابدأ الآن مع Google</span>
              </button>
            </motion.div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Input Section */}
            <div className="lg:col-span-2 space-y-6">
              <section className="bg-white rounded-3xl p-6 shadow-sm border border-stone-100">
                <h3 className="text-lg font-bold text-stone-800 mb-4 flex items-center gap-2">
                  <Activity className="w-5 h-5 text-emerald-600" />
                  كيف تشعر اليوم؟
                </h3>

                {/* Vital Signs / USB Input */}
                <div className="mb-6 p-4 bg-emerald-50/50 rounded-2xl border border-emerald-100">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center text-emerald-600 shadow-sm border border-emerald-100">
                        <Thermometer className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="text-sm font-bold text-stone-800">قياس درجة الحرارة</p>
                        <p className="text-xs text-stone-500">قم بتوصيل ميزان الحرارة USB</p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <input 
                          type="number" 
                          step="0.1"
                          value={temperature}
                          onChange={(e) => setTemperature(e.target.value)}
                          placeholder="37.0"
                          className="w-24 p-2 bg-white border border-emerald-200 rounded-lg text-center font-bold text-emerald-700 focus:ring-2 focus:ring-emerald-500 outline-none"
                        />
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-stone-400 text-xs">°C</span>
                      </div>
                      
                      <button 
                        onClick={simulateUsbReading}
                        disabled={readingUsb}
                        className={cn(
                          "flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all",
                          readingUsb 
                            ? "bg-stone-200 text-stone-400 cursor-wait" 
                            : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                        )}
                      >
                        {readingUsb ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Usb className="w-4 h-4" />
                        )}
                        <span>{readingUsb ? "جاري القراءة..." : "قراءة من USB"}</span>
                      </button>
                    </div>
                  </div>
                  
                  {/* Ignore Temperature Toggle */}
                  <div className="mt-4 pt-4 border-t border-emerald-100 flex items-center justify-end">
                    <label className="flex items-center gap-2 cursor-pointer group">
                      <span className="text-xs text-stone-500 group-hover:text-stone-700 transition-colors">تجاهل درجة الحرارة في التحليل</span>
                      <div className="relative inline-flex items-center cursor-pointer">
                        <input 
                          type="checkbox" 
                          className="sr-only peer"
                          checked={ignoreTemperature}
                          onChange={(e) => setIgnoreTemperature(e.target.checked)}
                        />
                        <div className="w-9 h-5 bg-stone-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Image Upload for Physical Signs */}
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-bold text-stone-700 flex items-center gap-2">
                      <ImageIcon className="w-4 h-4 text-emerald-600" />
                      إرفاق صورة (اختياري)
                    </p>
                    <p className="text-[10px] text-stone-400">للانتفاخ، الجروح، أو تغير اللون</p>
                  </div>
                  
                  <div className="flex gap-4">
                    {!imagePreview ? (
                      <div className="flex gap-2">
                        <label className="flex flex-col items-center justify-center w-24 h-24 border-2 border-dashed border-stone-200 rounded-2xl cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/30 transition-all group">
                          <Camera className="w-6 h-6 text-stone-400 group-hover:text-emerald-600 mb-1" />
                          <span className="text-[10px] font-bold text-stone-400 group-hover:text-emerald-700">كاميرا</span>
                          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleImageSelect} />
                        </label>
                        <label className="flex flex-col items-center justify-center w-24 h-24 border-2 border-dashed border-stone-200 rounded-2xl cursor-pointer hover:border-emerald-300 hover:bg-emerald-50/30 transition-all group">
                          <ImageIcon className="w-6 h-6 text-stone-400 group-hover:text-emerald-600 mb-1" />
                          <span className="text-[10px] font-bold text-stone-400 group-hover:text-emerald-700">معرض</span>
                          <input type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
                        </label>
                      </div>
                    ) : (
                      <div className="relative w-24 h-24 rounded-2xl overflow-hidden border border-emerald-100 shadow-sm">
                        <img src={imagePreview} alt="Preview" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        <button 
                          onClick={() => { setSelectedImage(null); setImagePreview(null); }}
                          className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="relative">
                  <textarea 
                    value={symptoms}
                    onChange={(e) => setSymptoms(e.target.value)}
                    placeholder="صف الأعراض التي تشعر بها بالتفصيل (مثال: أشعر بصداع شديد وألم في الحلق منذ يومين)..."
                    className="w-full h-40 p-4 bg-stone-50 border border-stone-200 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all resize-none text-stone-700 placeholder:text-stone-400"
                  />
                  <button 
                    onClick={analyzeSymptoms}
                    disabled={analyzing || !symptoms.trim()}
                    className={cn(
                      "absolute bottom-4 left-4 px-6 py-2 rounded-xl font-bold flex items-center gap-2 transition-all",
                      analyzing || !symptoms.trim() 
                        ? "bg-stone-200 text-stone-400 cursor-not-allowed" 
                        : "bg-emerald-600 text-white hover:bg-emerald-700 shadow-lg shadow-emerald-100"
                    )}
                  >
                    {analyzing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{analysisStep || "جاري التحليل..."}</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-4 h-4" />
                        <span>تحليل الأعراض</span>
                      </>
                    )}
                  </button>
                </div>
                {error && (
                  <p className="mt-3 text-red-500 text-sm flex items-center gap-1">
                    <AlertCircle className="w-4 h-4" />
                    {error}
                  </p>
                )}
                <p className="mt-4 text-xs text-slate-400 leading-relaxed">
                  * ملاحظة: هذا التطبيق يقدم نصائح أولية فقط ولا يغني عن استشارة الطبيب المختص. في الحالات الطارئة، يرجى الاتصال بالإسعاف فوراً.
                </p>
              </section>

              {/* Latest Analysis */}
              <AnimatePresence>
                {consultations.length > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4"
                  >
                    <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                      <History className="w-5 h-5 text-red-600" />
                      آخر التحليلات
                    </h3>
                    {consultations.map((item) => (
                      <div key={item.id} className="bg-white rounded-3xl p-6 shadow-sm border border-stone-100 overflow-hidden relative">
                        <div className={cn(
                          "absolute top-0 right-0 w-2 h-full",
                          item.analysis.urgency === 'high' ? "bg-red-500" :
                          item.analysis.urgency === 'medium' ? "bg-amber-500" : "bg-emerald-500"
                        )} />
                        
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <span className={cn(
                              "text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md mb-2 inline-block",
                              item.analysis.urgency === 'high' ? "bg-red-50 text-red-600" :
                              item.analysis.urgency === 'medium' ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"
                            )}>
                              {item.analysis.urgency === 'high' ? "خطورة عالية" :
                               item.analysis.urgency === 'medium' ? "خطورة متوسطة" : "خطورة منخفضة"}
                            </span>
                            <h4 className="text-xl font-bold text-stone-800">{item.analysis.possibleCondition}</h4>
                          </div>
                          <div className="text-left flex flex-col items-end gap-2">
                            <p className="text-xs text-stone-400 flex items-center gap-1 justify-end">
                              <Clock className="w-3 h-3" />
                              {item.createdAt?.toDate().toLocaleDateString('ar-SA')}
                            </p>
                            <div className="flex items-center gap-1">
                              {deletingId === item.id ? (
                                <div className="flex items-center gap-2 bg-red-50 p-1 px-2 rounded-lg border border-red-100">
                                  <span className="text-[10px] font-bold text-red-600">تأكيد؟</span>
                                  <button onClick={() => deleteConsultation(item.id)} className="text-[10px] bg-red-600 text-white px-2 py-0.5 rounded shadow-sm">نعم</button>
                                  <button onClick={() => setDeletingId(null)} className="text-[10px] bg-stone-200 text-stone-600 px-2 py-0.5 rounded shadow-sm">لا</button>
                                </div>
                              ) : (
                                <button 
                                  onClick={() => setDeletingId(item.id)}
                                  className="p-1.5 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                  title="حذف التحليل"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <div>
                            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-1">الأعراض الموصوفة</p>
                            <p className="text-stone-600 text-sm mb-2">{item.symptoms}</p>
                            
                            {/* Auto-detected Symptom Icons */}
                            <div className="flex flex-wrap gap-2 mb-3">
                              {getSymptomIcons(item.symptoms).map(({ Icon, color }, idx) => (
                                <div key={idx} className={cn("p-1.5 rounded-lg bg-stone-50 border border-stone-100 shadow-sm", color)} title="عرض العرض المكتشف">
                                  <Icon className="w-4 h-4" />
                                </div>
                              ))}
                            </div>

                            {item.temperature && (
                              <div className="mt-2 flex items-center gap-2 text-emerald-700 bg-emerald-50 w-fit px-2 py-1 rounded-lg border border-emerald-100">
                                <Thermometer className="w-3 h-3" />
                                <span className="text-xs font-bold">{item.temperature}°C</span>
                              </div>
                            )}
                          </div>
                          
                          {item.imageUrl && (
                            <div className="relative group overflow-hidden rounded-2xl border border-stone-100 shadow-sm max-w-xs">
                              <img 
                                src={item.imageUrl} 
                                alt="Affected area" 
                                className="w-full h-40 object-cover rounded-2xl group-hover:scale-105 transition-transform duration-500" 
                                referrerPolicy="no-referrer"
                              />
                              <a 
                                href={item.imageUrl} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white gap-2 font-bold text-sm"
                              >
                                <Eye className="w-4 h-4" />
                                <span>عرض الصورة</span>
                              </a>
                            </div>
                          )}
                          
                          <div className="bg-stone-50 rounded-2xl p-4 border border-stone-100">
                            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">النصيحة الطبية</p>
                            <p className="text-stone-700 text-sm leading-relaxed">{item.analysis.advice}</p>
                            
                            {item.analysis.sources && item.analysis.sources.length > 0 && (
                              <div className="mt-4 pt-3 border-t border-stone-200">
                                <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-2">المصادر المرجعية:</p>
                                <div className="flex flex-wrap gap-2">
                                  {item.analysis.sources.map((source, idx) => {
                                    const isUrl = source.startsWith('http');
                                    return isUrl ? (
                                      <a 
                                        key={idx} 
                                        href={source} 
                                        target="_blank" 
                                        rel="noopener noreferrer"
                                        className="text-[10px] bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded text-emerald-700 hover:bg-emerald-100 transition-colors flex items-center gap-1"
                                      >
                                        <span>رابط المصدر</span>
                                        <ExternalLink className="w-2 h-2" />
                                      </a>
                                    ) : (
                                      <span key={idx} className="text-[10px] bg-white border border-stone-200 px-2 py-0.5 rounded text-stone-500">
                                        {source}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center justify-between pt-2">
                            {item.sharedWithHospital ? (
                              <div className="flex items-center gap-2 text-emerald-600 text-sm font-bold">
                                <CheckCircle2 className="w-4 h-4" />
                                <span>تمت مشاركة البيانات مع الجهة الطبية</span>
                              </div>
                            ) : (
                              <button 
                                onClick={() => shareWithHospital(item.id)}
                                className="flex items-center gap-2 text-emerald-600 hover:text-emerald-700 text-sm font-bold transition-colors"
                              >
                                <Share2 className="w-4 h-4" />
                                <span>مشاركة البيانات مع مستشفى للحصول على استشارة</span>
                              </button>
                            )}
                          </div>

                          {/* Doctor's Notes Section */}
                          <div className="mt-4 pt-4 border-t border-stone-100 italic">
                            <p className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                              <Stethoscope className="w-3 h-3" />
                              ملاحظات الطبيب المختص
                            </p>
                            {item.doctorNotes ? (
                              <p className="text-stone-600 text-sm bg-emerald-50/30 p-3 rounded-xl border border-emerald-100">
                                {item.doctorNotes}
                              </p>
                            ) : (
                              <div className="bg-stone-50 rounded-xl p-3 border border-dashed border-stone-200">
                                <p className="text-xs text-stone-400 text-center">لا توجد ملاحظات مسجلة من الطبيب بعد.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Sidebar / Stats */}
            <div className="space-y-6">
              <section className="bg-emerald-900 rounded-3xl p-6 text-white shadow-xl shadow-emerald-900/10">
                <h3 className="font-bold mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-300" />
                  ملخص نشاطك
                </h3>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-emerald-100 text-sm">إجمالي الاستشارات</span>
                    <span className="text-2xl font-bold">{consultations.length}</span>
                  </div>
                  <div className="w-full h-1.5 bg-emerald-800 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-400 w-2/3" />
                  </div>
                  <p className="text-xs text-emerald-100 leading-relaxed">
                    أنت تتابع حالتك الصحية بانتظام. استمر في تسجيل أي أعراض غير طبيعية.
                  </p>
                </div>
              </section>

              <section className="bg-white rounded-3xl p-6 shadow-sm border border-stone-100">
                <h3 className="font-bold text-stone-800 mb-4">نصائح سريعة</h3>
                <ul className="space-y-4">
                  {[
                    "اشرب كميات كافية من الماء يومياً.",
                    "حافظ على 7-8 ساعات من النوم المنتظم.",
                    "مارس الرياضة الخفيفة لمدة 30 دقيقة."
                  ].map((tip, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-stone-600">
                      <div className="w-5 h-5 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5">
                        <CheckCircle2 className="w-3 h-3" />
                      </div>
                      {tip}
                    </li>
                  ))}
                </ul>
              </section>

              <div className="p-6 bg-stone-100 rounded-3xl border border-dashed border-stone-300">
                <p className="text-xs text-stone-500 text-center">
                  تحتاج مساعدة فورية؟<br/>
                  <span className="font-bold text-stone-700">اتصل بـ 997</span>
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="py-12 border-t border-stone-200 mt-20">
        <div className="max-w-5xl mx-auto px-4 text-center">
          <p className="text-stone-400 text-sm">© 2026 مُساعِد صحتي الذكي - جميع الحقوق محفوظة</p>
          <div className="flex justify-center gap-6 mt-4">
            <a href="#" className="text-stone-400 hover:text-emerald-600 text-xs transition-colors">سياسة الخصوصية</a>
            <a href="#" className="text-stone-400 hover:text-emerald-600 text-xs transition-colors">شروط الاستخدام</a>
            <a href="#" className="text-stone-400 hover:text-emerald-600 text-xs transition-colors">تواصل معنا</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
